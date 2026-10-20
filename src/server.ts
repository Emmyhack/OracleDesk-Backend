import http from 'http';
import { Server } from 'socket.io';
import { Keypair } from '@stellar/stellar-sdk';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import app from './app';
import { config } from './config';
import { initSecrets, startSecretRefresh } from './config/secrets';
import { assertEmbeddingConfig } from './services/embeddings.service';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { startDisputeCron } from './cron/dispute.cron';
import { startIngestionCron } from './cron/ingestion.cron';
import { startMonitorCron } from './cron/monitor.cron';
import { startReportCron } from './cron/report.cron';
import { startReconcileCron } from './cron/reconcile.cron';
import { startPriceResolutionCron } from './cron/price-resolution.cron';
import { bootstrapAdminRbac, isAdminToken } from './middlewares/auth.middleware';
import { startTraceAuditCron } from './cron/trace-audit.cron';
import { startTracePublicationCron } from './cron/trace-publication.cron';
import { startPaymentIntentCron } from './cron/payment-intent.cron';
import { startEventListener } from './services/indexer.service';
import { gateDecision, runSpecCompatGate } from './services/stellar/spec-compat';
import { startOutboxWorker } from './services/stellar/outbox';
import { closeRedis, getRedis, checkRedisPolicy } from './lib/redis';
import { memoryEventBus, redisEventBus } from './lib/event-bus';
import { startFanout, startLocalFanout } from './lib/fanout';
import { setControlEmitter } from './services/agent-controls.service';
import { attachSessionLifecycle, setRealtime, socketAuthMiddleware } from './lib/socket-auth';
import { health } from './services/health.service';

let stopEventListener: (() => void) | null = null;
let stopFanout: (() => Promise<void>) | null = null;
let stopSecretRefresh: (() => void) | null = null;
let stopOutboxWorker: (() => void) | null = null;

async function bootstrap(): Promise<void> {
  // 0. Resolve secrets (mounted files or the configured remote provider).
  try {
    await initSecrets(config);
    stopSecretRefresh = startSecretRefresh(config);
  } catch (err) {
    logger.fatal({ err: err instanceof Error ? err.message : err }, 'Failed to initialise secrets');
    process.exit(1);
  }

  // 0b. A dimension the markets.questionEmbedding column cannot hold fails here, not on the first insert.
  try {
    assertEmbeddingConfig();
  } catch (err) {
    logger.fatal({ err: err instanceof Error ? err.message : err }, 'Invalid embedding configuration');
    process.exit(1);
  }

  // 1. Connect to database
  try {
    await prisma.$connect();
    logger.info('Database connected');
  } catch (err) {
    logger.fatal({ err }, 'Failed to connect to database');
    process.exit(1);
  }

  if (config.ephemeralSecrets.length > 0) {
    logger.warn(
      { generated: config.ephemeralSecrets },
      'Generated ephemeral secrets for this process; sessions and challenges end on restart. Set them in .env.',
    );
  }
  // Seed the fixed RBAC catalogue and first-deploy admins from ADMIN_ADDRESSES.
  try {
    await bootstrapAdminRbac();
  } catch (err) {
    logger.fatal({ err }, 'Failed to initialise admin RBAC');
    process.exit(1);
  }

  logger.info({ mode: config.CHAIN_EXECUTION_MODE }, 'Chain execution mode');

  // #50: challenges must not be evicted before their TTL, and non-TTL data
  // (locks, queues) shares this Redis. Warn on a policy that evicts them.
  await checkRedisPolicy();

  // Initialise the cached agent sequence before any live write can race (#36).
  if (config.CHAIN_EXECUTION_MODE === 'live' && config.AGENT_SECRET_KEY) {
    try {
      const { syncSequence } = await import('./services/stellar/sequence');
      const agent = Keypair.fromSecret(config.AGENT_SECRET_KEY).publicKey();
      const sequence = await syncSequence(agent);
      logger.info({ agent, sequence: sequence.toString() }, 'Agent sequence cache initialised');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Could not initialise the agent sequence cache; live writes will resync on first use');
    }
  }

  // 1b. Contract spec compatibility gate (#34): verify the deployed contracts
  // still run what the synced bindings were generated from, before anything
  // simulates calls or decodes events against those bindings. Live mode
  // refuses to start on breaking drift; dry-run warns and keeps running.
  const specCompat = await runSpecCompatGate();
  if (specCompat && gateDecision(specCompat, specCompat.mode) === 'refuse') {
    process.exit(1);
  }

  // 1c. Transaction outbox recovery (#35): resolve whatever a previous process
  // left in flight before the indexer and crons start issuing new writes, then
  // keep recovering on an interval (one instance at a time via a Redis lock).
  stopOutboxWorker = startOutboxWorker();

  // 2. Start HTTP server with Socket.io
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: config.CORS_ORIGINS,
      methods: ['GET', 'POST'],
    },
  });

  // Authenticated sockets (#94) and cluster-wide broadcast (#93). The Redis
  // adapter makes one io.emit / io.to(room).emit reach every instance. Redis
  // being down at boot is not fatal: the adapter and the bus reconnect, and the
  // indexer keeps events unpublished until the bus accepts them.
  io.use(socketAuthMiddleware());
  attachSessionLifecycle(io);
  setRealtime(io);
  if (config.EVENT_BUS_ENABLED) {
    io.adapter(createAdapter(getRedis(), { streamName: 'oracledesk:socket.io', blockTimeInMs: 1000 }));
  } else {
    logger.warn('EVENT_BUS_ENABLED=false: in-process event bus; socket events reach this instance only');
  }

  // 3. Index Stellar events (resumes from the stored ledger cursor). The
  // indexer publishes to the bus; one elected instance fans out to sockets.
  const bus = config.EVENT_BUS_ENABLED ? redisEventBus() : memoryEventBus();
  stopFanout = config.EVENT_BUS_ENABLED ? startFanout(bus, io) : startLocalFanout(bus, io);
  stopEventListener = startEventListener(async (type, payload, meta) => {
    await bus.publish({ ...meta, type, payload });
  });

  // 4. Start cron jobs
  startIngestionCron();
  startMonitorCron();
  startReportCron();
  startTraceAuditCron();
  startTracePublicationCron();
  startPaymentIntentCron();
  // Drift reports reach admins only: sockets join the room with an admin JWT.
  // Agent pause / resume notifications (#79).
  setControlEmitter((event, payload) => io.emit(event, payload));
  startReconcileCron((event, payload) => io.to('admins').emit(event, payload));
  // Price-mode reveal + resolve loop (#90).
  startPriceResolutionCron();

  io.on('connection', async (socket) => {
    logger.info({ socketId: socket.id }, 'New client connected to socket.io');
    if (await isAdminToken(socket.handshake.auth?.token)) void socket.join('admins');
    
    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, 'Client disconnected from socket.io');
    });
  });

  server.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      `OracleDesk backend running on port ${config.PORT}`,
    );
  });

  // ─── Graceful Shutdown ───
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down gracefully...');
    // Force exit if shutdown (drain + close) takes too long
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 15_000);
    // Report 503 from /readyz first so load balancers stop routing before the socket closes.
    health.startDraining();
    await new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_DRAIN_MS));
    const { triggerShutdown } = await import('./lib/shutdown');
    triggerShutdown();

    // Stop producing and consuming first, then close sockets and the HTTP
    // server (io.close also closes `server`), then the shared connections.
    if (stopEventListener) stopEventListener();
    // In-flight outbox rows stay in the table and resolve on the next boot.
    if (stopOutboxWorker) stopOutboxWorker();
    if (stopSecretRefresh) stopSecretRefresh();
    if (stopFanout) await stopFanout().catch(() => undefined);
    io.close(async () => {
      await prisma.$disconnect();
      await closeRedis();
      logger.info('Database disconnected');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    health.markFatal();
    logger.fatal({ err }, 'Uncaught exception — shutting down');
    process.exit(1);
  });
}

bootstrap();
