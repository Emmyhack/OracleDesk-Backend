import http from 'http';
import { Server } from 'socket.io';
import app from './app';
import { config } from './config';
import { initSecrets, startSecretRefresh } from './config/secrets';
import { assertEmbeddingConfig } from './services/embeddings.service';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { startIngestionCron } from './cron/ingestion.cron';
import { startMonitorCron } from './cron/monitor.cron';
import { startReportCron } from './cron/report.cron';
import { startTraceAuditCron } from './cron/trace-audit.cron';
import { startTracePublicationCron } from './cron/trace-publication.cron';
import { startEventListener } from './services/indexer.service';
import { closeRedis } from './lib/redis';
import { health } from './services/health.service';

let stopEventListener: (() => void) | null = null;
let stopSecretRefresh: (() => void) | null = null;

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
  logger.info({ mode: config.CHAIN_EXECUTION_MODE }, 'Chain execution mode');

  // 2. Start HTTP server with Socket.io
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: config.CORS_ORIGINS,
      methods: ['GET', 'POST'],
    },
  });

  // 3. Index Stellar events (resumes from the stored ledger cursor)
  stopEventListener = startEventListener((event, payload) => io.emit(event, payload));

  // 4. Start cron jobs
  startIngestionCron();
  startMonitorCron();
  startReportCron();
  startTraceAuditCron();
  startTracePublicationCron();

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'New client connected to socket.io');
    
    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, 'Client disconnected from socket.io');
    });
  });

  // Make io accessible via app
  app.set('io', io);

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

    server.close(async () => {
      if (stopEventListener) stopEventListener();
      if (stopSecretRefresh) stopSecretRefresh();

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
