/**
 * Socket authentication and private per-user events (#94).
 *
 * - The handshake carries the same JWT the REST API issues, in
 *   `socket.handshake.auth.token`. No token means an anonymous socket that
 *   still receives public events; an invalid or expired one fails the
 *   handshake with a machine-readable code.
 * - Authenticated sockets join `user:<userId>`. Private events go only
 *   through emitToUser(), which targets that room.
 * - A session ends at the token's `exp`: the socket gets SESSION_EXPIRED and
 *   leaves its user room but stays connected for public events. A `reauth`
 *   message with a fresh token for the same user restores it.
 *
 * Tokens are never logged; only the user id is.
 */
import type { Server, Socket } from 'socket.io';
import { logger } from './logger';
import { verifyAccessToken } from '../middlewares/auth.middleware';

export interface SocketUser {
  userId: string;
  walletAddress: string;
  /** Seconds since the epoch, from the token. */
  exp: number;
}

export const PRIVATE_EVENTS = ['PAYMENT_CONFIRMED', 'PASS_EXPIRING', 'COPY_TRADE_CONFIRMED'] as const;
export type PrivateEvent = (typeof PRIVATE_EVENTS)[number];

export type SocketAuthCode = 'INVALID_TOKEN' | 'TOKEN_EXPIRED' | 'TOKEN_IN_QUERY';

type ExtendedError = Error & { data?: unknown };

/** Node's setTimeout overflows to "immediately" above 2^31-1 ms (~24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export const userRoom = (userId: string): string => `user:${userId}`;

export function isPrivateEvent(event: string): event is PrivateEvent {
  return (PRIVATE_EVENTS as readonly string[]).includes(event);
}

/** Guards every global (public) emit: private events must never go through it. */
export function assertPublic(event: string): void {
  if (isPrivateEvent(event)) {
    throw new Error(`${event} is a private event and cannot be broadcast; use emitToUser`);
  }
}

// ─── Registry ────────────────────────────────────────────────────────────

let realtime: Server | null = null;

/** Lets services emit without importing server.ts (which has side effects). */
export function setRealtime(io: Server | null): void {
  realtime = io;
}

export function getRealtime(): Server | null {
  return realtime;
}

/** Emits a private event to every socket of one user, on any instance. */
export function emitToUser(io: Server, userId: string, event: PrivateEvent, payload: unknown): void {
  if (!isPrivateEvent(event)) throw new Error(`${event} is not a private event`);
  io.to(userRoom(userId)).emit(event, payload);
}

/** emitToUser through the registry; a no-op (with a debug line) before the server exists. */
export function notifyUser(userId: string, event: PrivateEvent, payload: unknown): void {
  const io = realtime;
  if (!io) {
    logger.debug({ userId, event }, 'No realtime server registered; private event dropped');
    return;
  }
  try {
    emitToUser(io, userId, event, payload);
  } catch (err) {
    logger.error({ err, userId, event }, 'Failed to emit private event');
  }
}

// ─── Handshake ───────────────────────────────────────────────────────────

function authError(code: SocketAuthCode): ExtendedError {
  const err: ExtendedError = new Error(code);
  err.data = { code };
  return err;
}

function toSocketUser(payload: { userId: string; walletAddress: string; exp?: number }): SocketUser | null {
  // Without exp the session lifetime cannot be enforced, so it is not accepted.
  if (!payload.userId || typeof payload.exp !== 'number') return null;
  return { userId: payload.userId, walletAddress: payload.walletAddress, exp: payload.exp };
}

function readUser(token: unknown): { user?: SocketUser; code?: SocketAuthCode } {
  if (typeof token !== 'string' || token.length === 0) return { code: 'INVALID_TOKEN' };
  const { user, error } = verifyAccessToken(token);
  if (!user) return { code: error === 'expired' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN' };
  const socketUser = toSocketUser(user);
  return socketUser ? { user: socketUser } : { code: 'INVALID_TOKEN' };
}

/**
 * Handshake middleware. Anonymous when no token is sent; tokens in the query
 * string are refused outright because URLs end up in proxy and access logs.
 */
export function socketAuthMiddleware(): (socket: Socket, next: (err?: ExtendedError) => void) => void {
  return (socket, next) => {
    if (socket.handshake.query?.token !== undefined) {
      next(authError('TOKEN_IN_QUERY'));
      return;
    }
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (token === undefined || token === null || token === '') {
      socket.data.user = undefined;
      next();
      return;
    }
    const { user, code } = readUser(token);
    if (!user) {
      next(authError(code ?? 'INVALID_TOKEN'));
      return;
    }
    socket.data.user = user;
    void socket.join(userRoom(user.userId));
    next();
  };
}

// ─── Session lifecycle ───────────────────────────────────────────────────

const timers = new WeakMap<Socket, NodeJS.Timeout>();

function clearTimer(socket: Socket): void {
  const timer = timers.get(socket);
  if (timer) clearTimeout(timer);
  timers.delete(socket);
}

function expireSession(socket: Socket): void {
  const user = socket.data.user as SocketUser | undefined;
  if (!user) return;
  socket.data.sessionExpired = true;
  socket.emit('SESSION_EXPIRED', { reason: 'TOKEN_EXPIRED' });
  void socket.leave(userRoom(user.userId));
  logger.info({ userId: user.userId, socketId: socket.id }, 'Socket session expired');
}

function armExpiry(socket: Socket, expSeconds: number): void {
  clearTimer(socket);
  const remaining = expSeconds * 1000 - Date.now();
  if (remaining <= 0) {
    expireSession(socket);
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(socket);
    armExpiry(socket, expSeconds); // re-arms in chunks, or expires when due
  }, Math.min(remaining, MAX_TIMER_MS));
  timer.unref?.();
  timers.set(socket, timer);
}

type Ack = (reply: { ok: boolean; exp?: number; code?: string }) => void;

/** Arms expiry for authenticated sockets and handles `reauth`. */
export function attachSessionLifecycle(io: Server): void {
  io.on('connection', (socket) => {
    const user = socket.data.user as SocketUser | undefined;
    if (user) armExpiry(socket, user.exp);

    socket.on('reauth', (payload: unknown, ack?: Ack) => {
      const reply: Ack = typeof ack === 'function' ? ack : () => undefined;
      const token = payload && typeof payload === 'object' ? (payload as { token?: unknown }).token : undefined;
      const { user: next, code } = readUser(token);
      if (!next) {
        reply({ ok: false, code: code ?? 'INVALID_TOKEN' });
        return;
      }
      const current = socket.data.user as SocketUser | undefined;
      if (current && current.userId !== next.userId) {
        reply({ ok: false, code: 'USER_MISMATCH' });
        return;
      }
      socket.data.user = next;
      socket.data.sessionExpired = false;
      void socket.join(userRoom(next.userId));
      armExpiry(socket, next.exp);
      reply({ ok: true, exp: next.exp });
    });

    socket.on('disconnect', () => clearTimer(socket));
  });
}
