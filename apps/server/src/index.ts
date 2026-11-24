import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  CHAT_MESSAGES_PER_WINDOW,
  CHAT_WINDOW_MS,
  FALLBACK_LOCATION,
  INTEREST_RADIUS_CELLS,
  MAX_CONNECTIONS,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS_PER_CELL,
  MAX_ROUTE_DISTANCE_METERS,
  MAX_RELAYED_PLAYERS,
  MAX_STATE_MESSAGES_PER_SECOND,
  MAX_WORLD_ACTORS,
  MAX_WORLD_CONTROLS,
  MAX_WORLD_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RELOCATIONS_PER_WINDOW,
  RELOCATION_WINDOW_MS,
  ROUTE_WINDOW_MS,
  ROUTES_PER_WINDOW,
  ROOM_TILE_ZOOM,
  SERVER_BROADCAST_INTERVAL_MS,
  type ClientMessage,
  type MissionOffer,
  type NetworkCarState,
  type PublicPlayerState,
  type ServerMessage,
  type WorldSnapshot,
} from '@openstreet-racer/shared';
import { getVehicleDefinition, isVehicleId } from '@openstreet-racer/vehicle/catalog';
import { haversineMeters, tileCellAt } from '@openstreet-racer/world';

import { AmbientWorld, type AmbientWorldService } from './ambient-world';
import { InterestManager } from './interest';
import { OsmDataSource } from './osm-data';
import { limitTeleportDistance, parseClientMessage, publicPlayer } from './validation';
import { PlayerStore } from './player-store';
import { createCommunityRaceOffer } from './mission-generator';
import { CommunityRaceStore } from './community-race-store';
import { loadMissionMods, loadVehicleMods } from './mod-loader';

const MAX_INVALID_MESSAGES = 3;
const MAX_SERVER_BUFFERED_BYTES = 256 * 1024;
const MAX_GENERAL_MESSAGES_PER_SECOND = 60;
const IDLE_TIMEOUT_MS = 45_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_PORT = 3001;
const AMBIENT_UPDATE_INTERVAL_MS = 500;
const MISSION_REQUEST_WINDOW_MS = 60_000;
const MISSION_REQUESTS_PER_WINDOW = 6;
const DAMAGE_REPORT_WINDOW_MS = 1_000;
const REPAIR_COST_CENTS_PER_DAMAGE = 25;
const MISSION_EXPIRY_MS = 30 * 60_000;
const PICKUP_RADIUS_METERS = 45;
const FINISH_RADIUS_METERS = 45;
const CHECKPOINT_RADIUS_METERS = 55;
const MAX_DAMAGE_INCREASE_PER_REPORT = 20;
const RACE_CREATE_WINDOW_MS = 60_000;
const RACES_PER_WINDOW = 2;
const SERVER_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_WEB_ROOT = resolve(SERVER_DIRECTORY, '../../web/dist');
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
};

export interface GameServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly webRoot?: string;
  readonly allowedOrigins?: readonly string[];
  readonly now?: () => number;
  readonly ambientWorld?: AmbientWorldService | null;
  readonly playerStore?: PlayerStore;
  readonly communityRaceStore?: CommunityRaceStore;
}

interface Session {
  readonly id: string;
  readonly socket: WebSocket;
  handle: string;
  joining: boolean;
  anonymousPlayerId: string;
  selectedVehicleId: string;
  missionOffers: Map<string, MissionOffer>;
  car: NetworkCarState;
  lastSeenAt: number;
  lastStateAt: number;
  lastSequence: number;
  invalidMessages: number;
  stateTimes: number[];
  chatTimes: number[];
  relocationTimes: number[];
  routeTimes: number[];
  missionTimes: number[];
  raceTimes: number[];
  damageTimes: number[];
  messageTimes: number[];
  actionQueue: Promise<void>;
  lastWorldAt: number;
}

export function createGameServer(options: GameServerOptions = {}) {
  const now = options.now ?? Date.now;
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? readPort(process.env.PORT, DEFAULT_PORT);
  const webRoot = resolve(options.webRoot ?? process.env.WEB_ROOT ?? DEFAULT_WEB_ROOT);
  const allowedOrigins = options.allowedOrigins ?? readAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const ambientWorld =
    options.ambientWorld === undefined
      ? new AmbientWorld(new OsmDataSource())
      : options.ambientWorld;
  const interest = new InterestManager(INTEREST_RADIUS_CELLS, MAX_PLAYERS_PER_CELL);
  const playerStore = options.playerStore ?? new PlayerStore();
  const communityRaceStore = options.communityRaceStore ?? new CommunityRaceStore();
  const sessions = new Map<string, Session>();
  const socketSessions = new Map<WebSocket, Session>();
  const playerActionQueues = new Map<string, Promise<void>>();
  const dirtyStates = new Set<string>();
  const httpServer = createServer((request, response) => {
    void handleHttp(request, response, webRoot, sessions.size, interest.getCellCount());
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const origin = request.headers.origin;
    if (allowedOrigins.length > 0 && (!origin || !allowedOrigins.includes(origin))) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (socketSessions.size >= MAX_CONNECTIONS) {
      rejectUpgrade(socket, 503, 'Server Full');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request);
    });
  });

  webSocketServer.on('connection', (socket) => {
    const timestamp = now();
    const session: Session = {
      id: randomUUID(),
      socket,
      handle: '',
      joining: false,
      anonymousPlayerId: randomUUID(),
      selectedVehicleId: 'sedan',
      missionOffers: new Map(),
      car: fallbackCar(),
      lastSeenAt: timestamp,
      lastStateAt: timestamp,
      lastSequence: -1,
      invalidMessages: 0,
      stateTimes: [],
      chatTimes: [],
      relocationTimes: [],
      routeTimes: [],
      missionTimes: [],
      raceTimes: [],
      damageTimes: [],
      messageTimes: [],
      actionQueue: Promise.resolve(),
      lastWorldAt: 0,
    };
    socketSessions.set(socket, session);
    socket.on('message', (data, isBinary) => handleMessage(session, data, isBinary));
    socket.on('pong', () => {
      session.lastSeenAt = now();
    });
    socket.on('close', () => removeSession(session));
    socket.on('error', () => removeSession(session));
  });

  const broadcastTimer = setInterval(flushStates, SERVER_BROADCAST_INTERVAL_MS);
  const heartbeatTimer = setInterval(heartbeat, KEEPALIVE_INTERVAL_MS);
  const ambientTimer = ambientWorld ? setInterval(flushWorld, AMBIENT_UPDATE_INTERVAL_MS) : null;
  broadcastTimer.unref();
  heartbeatTimer.unref();
  ambientTimer?.unref();

  function handleMessage(session: Session, rawData: RawData, isBinary: boolean): void {
    const timestamp = now();
    session.lastSeenAt = timestamp;
    if (isBinary) {
      invalid(session, 'BINARY_NOT_SUPPORTED', 'Messages must use UTF-8 JSON.');
      return;
    }
    const parsed = parseClientMessage(rawData.toString());
    if (!parsed.ok) {
      invalid(session, parsed.code, parsed.message);
      return;
    }
    if (!takeWindow(session.messageTimes, timestamp, 1_000, MAX_GENERAL_MESSAGES_PER_SECOND)) {
      invalid(session, 'MESSAGE_RATE_LIMIT', 'Too many messages.');
      return;
    }
    const message = parsed.message;
    if (!sessions.has(session.id)) {
      if (message.type !== 'hello') {
        invalid(session, 'HELLO_REQUIRED', 'Send a hello message before joining.');
        return;
      }
      if (session.joining) {
        invalid(session, 'JOIN_IN_PROGRESS', 'Player data is still loading.');
        return;
      }
      session.joining = true;
      void join(session, message, timestamp).catch(() => {
        send(
          session.socket,
          errorMessage('PLAYER_DATA_UNAVAILABLE', 'Player data could not be loaded.'),
        );
        session.socket.close(1011, 'Player data unavailable');
      });
      return;
    }
    if (message.type === 'hello') {
      invalid(session, 'ALREADY_JOINED', 'This connection has already joined.');
      return;
    }
    session.invalidMessages = 0;
    switch (message.type) {
      case 'state':
        updateState(session, message, timestamp);
        break;
      case 'relocate':
        relocate(session, message, timestamp);
        break;
      case 'chat':
        relayChat(session, message, timestamp);
        break;
      case 'ping':
        send(session.socket, {
          version: PROTOCOL_VERSION,
          type: 'pong',
          clientTimeMs: message.clientTimeMs,
          serverTimeMs: timestamp,
        });
        break;
      case 'route':
        requestRoute(session, message, timestamp);
        break;
      case 'missions-request':
        requestMissions(session, timestamp);
        break;
      case 'race-create':
        queueSessionAction(session, () => handleRaceCreate(session, message, timestamp));
        break;
      case 'mission-action':
        queueSessionAction(session, () => handleMissionAction(session, message, timestamp));
        break;
      case 'garage-action':
        queueSessionAction(session, () => handleGarageAction(session, message));
        break;
      case 'leaderboard-request':
        queueSessionAction(session, () => handleLeaderboardRequest(session, message));
        break;
      case 'damage-report':
        queueSessionAction(session, () => handleDamageReport(session, message, timestamp));
        break;
    }
  }

  async function join(
    session: Session,
    message: Extract<ClientMessage, { type: 'hello' }>,
    timestamp: number,
  ): Promise<void> {
    session.handle = message.handle || `Driver-${session.id.slice(0, 5)}`;
    session.anonymousPlayerId = message.anonymousPlayerId ?? session.anonymousPlayerId;
    let profile = await playerStore.getOrCreate(session.anonymousPlayerId, session.handle);
    if (profile.activeMission && timestamp - profile.activeMission.acceptedAtMs > 30 * 60_000) {
      profile = await playerStore.updateProfile(
        session.anonymousPlayerId,
        (current) => ({ ...current, activeMission: null }),
        session.handle,
      );
    }
    if (!socketSessions.has(session.socket) || session.socket.readyState !== WebSocket.OPEN) return;
    session.joining = false;
    session.selectedVehicleId = profile.selectedVehicleId;
    session.car = { ...message.car, vehicleId: session.selectedVehicleId };
    session.lastStateAt = timestamp;
    sessions.set(session.id, session);
    const delta = interest.update(session.id, session.car.position);
    if (delta.fullCells.some((cell) => cell.key === delta.centerCell.key)) {
      sessions.delete(session.id);
      interest.remove(session.id);
      send(
        session.socket,
        errorMessage('CELL_FULL', 'This nearby area is full. Try another location.'),
      );
      session.socket.close(1013, 'Area full');
      return;
    }
    send(session.socket, {
      version: PROTOCOL_VERSION,
      type: 'welcome',
      playerId: session.id,
      handle: session.handle,
      serverTimeMs: timestamp,
      profile,
    });
    sendRoster(session);
    for (const peerId of limitedPeers(session.id)) {
      const peer = sessions.get(peerId);
      if (peer) sendRoster(peer);
    }
    void ambientWorld?.prepare(session.car.position).catch(() => undefined);
  }

  function updateState(
    session: Session,
    message: Extract<ClientMessage, { type: 'state' }>,
    timestamp: number,
  ): void {
    if (message.seq <= session.lastSequence) return;
    if (!takeWindow(session.stateTimes, timestamp, 1_000, MAX_STATE_MESSAGES_PER_SECOND)) {
      invalid(session, 'STATE_RATE_LIMIT', 'Player state updates are arriving too quickly.');
      return;
    }
    const elapsedSeconds = Math.max(0.05, (timestamp - session.lastStateAt) / 1_000);
    const previousCar = session.car;
    session.car = limitTeleportDistance(
      { ...message.car, vehicleId: session.selectedVehicleId },
      previousCar,
      elapsedSeconds,
    );
    if (!refreshInterest(session, previousCar)) return;
    session.lastSequence = message.seq;
    session.lastStateAt = timestamp;
    dirtyStates.add(session.id);
  }

  function relocate(
    session: Session,
    message: Extract<ClientMessage, { type: 'relocate' }>,
    timestamp: number,
  ): void {
    if (message.seq <= session.lastSequence) return;
    if (
      !takeWindow(session.relocationTimes, timestamp, RELOCATION_WINDOW_MS, RELOCATIONS_PER_WINDOW)
    ) {
      invalid(session, 'RELOCATION_RATE_LIMIT', 'Too many location changes.');
      return;
    }
    const previousCar = session.car;
    session.car = { ...message.car, vehicleId: session.selectedVehicleId };
    if (!refreshInterest(session, previousCar)) return;
    session.lastSequence = message.seq;
    session.lastStateAt = timestamp;
    dirtyStates.add(session.id);
  }

  function refreshInterest(session: Session, previousCar: NetworkCarState): boolean {
    const previousPeers = interest.getPeers(session.id);
    const delta = interest.update(session.id, session.car.position);
    if (delta.fullCells.some((cell) => cell.key === delta.centerCell.key)) {
      session.car = previousCar;
      interest.update(session.id, previousCar.position);
      send(
        session.socket,
        errorMessage('CELL_FULL', 'This nearby area is full; your previous position was kept.'),
      );
      return false;
    }
    const currentPeers = interest.getPeers(session.id);
    for (const peerId of previousPeers) {
      if (currentPeers.has(peerId)) continue;
      const peer = sessions.get(peerId);
      if (peer)
        send(peer.socket, { version: PROTOCOL_VERSION, type: 'player-left', playerId: session.id });
    }
    for (const peerId of currentPeers) {
      if (previousPeers.has(peerId)) continue;
      const peer = sessions.get(peerId);
      if (peer) sendRoster(peer);
      sendRoster(session);
    }
    return true;
  }

  function relayChat(
    session: Session,
    message: Extract<ClientMessage, { type: 'chat' }>,
    timestamp: number,
  ): void {
    if (!takeWindow(session.chatTimes, timestamp, CHAT_WINDOW_MS, CHAT_MESSAGES_PER_WINDOW)) {
      send(
        session.socket,
        errorMessage('CHAT_RATE_LIMIT', 'Please wait before sending another chat message.'),
      );
      return;
    }
    const outgoing: ServerMessage = {
      version: PROTOCOL_VERSION,
      type: 'chat',
      playerId: session.id,
      handle: session.handle,
      text: message.text,
      serverTimeMs: timestamp,
    };
    send(session.socket, outgoing);
    for (const peerId of limitedPeers(session.id)) {
      const peer = sessions.get(peerId);
      if (peer) send(peer.socket, outgoing);
    }
  }

  function sendRoster(session: Session): void {
    const timestamp = now();
    const players = limitedPeers(session.id)
      .map((id) => sessions.get(id))
      .filter((peer): peer is Session => Boolean(peer))
      .map((peer) => publicState(peer, timestamp));
    send(session.socket, {
      version: PROTOCOL_VERSION,
      type: 'roster',
      players,
      serverTimeMs: timestamp,
    });
  }

  function limitedPeers(clientId: string): string[] {
    return [...interest.getPeers(clientId)].slice(0, MAX_RELAYED_PLAYERS);
  }

  function publicState(session: Session, timestamp: number): PublicPlayerState {
    return publicPlayer(session.id, session.handle, session.car, timestamp);
  }

  function flushStates(): void {
    if (!dirtyStates.size) return;
    const timestamp = now();
    const changed = [...dirtyStates]
      .map((id) => sessions.get(id))
      .filter((session): session is Session => Boolean(session));
    dirtyStates.clear();
    const byRecipient = new Map<string, PublicPlayerState[]>();
    for (const changedSession of changed) {
      const player = publicState(changedSession, timestamp);
      for (const recipientId of limitedPeers(changedSession.id)) {
        const players = byRecipient.get(recipientId) ?? [];
        players.push(player);
        byRecipient.set(recipientId, players);
      }
    }
    for (const [recipientId, players] of byRecipient) {
      const recipient = sessions.get(recipientId);
      if (recipient && players.length) {
        send(recipient.socket, {
          version: PROTOCOL_VERSION,
          type: 'states',
          players,
          serverTimeMs: timestamp,
        });
      }
    }
  }

  function flushWorld(): void {
    if (!ambientWorld) return;
    const timestamp = now();
    for (const session of sessions.values()) {
      if (timestamp - session.lastWorldAt < AMBIENT_UPDATE_INTERVAL_MS) continue;
      session.lastWorldAt = timestamp;
      const snapshot = ambientWorld.getSnapshot(session.car.position, timestamp);
      sendWorld(session.socket, snapshot);
    }
  }

  function requestRoute(
    session: Session,
    message: Extract<ClientMessage, { type: 'route' }>,
    timestamp: number,
  ): void {
    if (!takeWindow(session.routeTimes, timestamp, ROUTE_WINDOW_MS, ROUTES_PER_WINDOW)) {
      sendRouteFailure(session, message.requestId, 'Please wait before requesting another route.');
      return;
    }
    if (!ambientWorld) {
      sendRouteFailure(session, message.requestId, 'Road data is unavailable right now.');
      return;
    }
    void ambientWorld
      .findRoute(session.car.position, message.destination)
      .then((route) => {
        if (!sessions.has(session.id)) return;
        send(session.socket, {
          version: PROTOCOL_VERSION,
          type: 'route-result',
          result: { requestId: message.requestId, ok: true, ...route },
        });
      })
      .catch(() => {
        if (sessions.has(session.id)) {
          sendRouteFailure(session, message.requestId, 'No drivable route was found in this area.');
        }
      });
  }

  function queueSessionAction(session: Session, action: () => Promise<void>): void {
    const playerId = session.anonymousPlayerId;
    const previous = playerActionQueues.get(playerId) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    playerActionQueues.set(playerId, lock);
    session.actionQueue = session.actionQueue
      .catch(() => undefined)
      .then(async () => {
        await previous.catch(() => undefined);
        try {
          if (sessions.has(session.id)) await action();
        } finally {
          release();
          if (playerActionQueues.get(playerId) === lock) playerActionQueues.delete(playerId);
        }
      })
      .catch(() => {
        if (sessions.has(session.id)) {
          send(
            session.socket,
            errorMessage('PLAYER_DATA_UNAVAILABLE', 'Progress could not be saved.'),
          );
        }
      });
  }

  async function handleRaceCreate(
    session: Session,
    message: Extract<ClientMessage, { type: 'race-create' }>,
    timestamp: number,
  ): Promise<void> {
    if (!takeWindow(session.raceTimes, timestamp, RACE_CREATE_WINDOW_MS, RACES_PER_WINDOW)) {
      send(session.socket, errorMessage('RACE_RATE_LIMIT', 'Wait before publishing another race.'));
      return;
    }
    if (!ambientWorld) {
      send(session.socket, errorMessage('RACE_UNAVAILABLE', 'Road data is unavailable right now.'));
      return;
    }
    const directDistance = haversineMeters(session.car.position, message.destination);
    if (directDistance < 300 || directDistance > MAX_ROUTE_DISTANCE_METERS) {
      send(
        session.socket,
        errorMessage('RACE_DISTANCE', 'Choose a destination 300 m to 7 km away.'),
      );
      return;
    }
    let routePlan: Awaited<ReturnType<AmbientWorldService['findRoute']>>;
    try {
      routePlan = await ambientWorld.findRoute(session.car.position, message.destination);
    } catch {
      send(session.socket, errorMessage('RACE_ROUTE_FAILED', 'No drivable route was found.'));
      return;
    }
    if (!sessions.has(session.id)) return;
    const offer = createCommunityRaceOffer(
      `community-race-${randomUUID()}`,
      message.title,
      session.handle,
      session.car.position,
      message.destination,
      routePlan,
    );
    if (!offer) {
      send(
        session.socket,
        errorMessage('RACE_DISTANCE', 'The routed race must be 300 m to 7 km long.'),
      );
      return;
    }
    try {
      const created = await communityRaceStore.create(offer);
      session.missionOffers.set(created.id, created);
      send(session.socket, { version: PROTOCOL_VERSION, type: 'race-created', offer: created });
      const [profile, offers] = await Promise.all([
        playerStore.getOrCreate(session.anonymousPlayerId, session.handle),
        loadMissionOffers(session.car.position),
      ]);
      if (!sessions.has(session.id)) return;
      session.missionOffers = new Map(offers.map((candidate) => [candidate.id, candidate]));
      send(session.socket, {
        version: PROTOCOL_VERSION,
        type: 'missions',
        offers,
        activeMission: profile.activeMission,
      });
    } catch {
      send(session.socket, errorMessage('RACE_SAVE_FAILED', 'Race could not be published.'));
    }
  }

  function requestMissions(session: Session, timestamp: number): void {
    if (
      !takeWindow(
        session.missionTimes,
        timestamp,
        MISSION_REQUEST_WINDOW_MS,
        MISSION_REQUESTS_PER_WINDOW,
      )
    ) {
      send(
        session.socket,
        errorMessage('MISSION_RATE_LIMIT', 'Please wait before refreshing missions.'),
      );
      return;
    }
    void loadMissionOffers(session.car.position)
      .then(async (offers) => {
        if (!sessions.has(session.id)) return;
        session.missionOffers = new Map(offers.map((offer) => [offer.id, offer]));
        const profile = await playerStore.getOrCreate(session.anonymousPlayerId, session.handle);
        send(session.socket, {
          version: PROTOCOL_VERSION,
          type: 'missions',
          offers,
          activeMission: profile.activeMission,
        });
      })
      .catch(() => {
        if (!sessions.has(session.id)) return;
        send(
          session.socket,
          errorMessage('MISSIONS_UNAVAILABLE', 'Real-world missions are unavailable right now.'),
        );
      });
  }

  async function loadMissionOffers(location: {
    longitude: number;
    latitude: number;
  }): Promise<readonly MissionOffer[]> {
    const [regularOffers, communityOffers] = await Promise.all([
      ambientWorld?.getMissionOffers(location) ?? Promise.resolve([]),
      communityRaceStore.listNearby(location),
    ]);
    return [...regularOffers, ...communityOffers].slice(0, 32);
  }

  async function handleMissionAction(
    session: Session,
    message: Extract<ClientMessage, { type: 'mission-action' }>,
    timestamp: number,
  ): Promise<void> {
    let profile = await playerStore.getOrCreate(session.anonymousPlayerId, session.handle);
    if (message.action === 'accept') {
      const offer = session.missionOffers.get(message.missionId);
      if (!offer) {
        send(
          session.socket,
          errorMessage('MISSION_NOT_FOUND', 'Refresh the mission list and try again.'),
        );
        return;
      }
      const acceptance = await playerStore.acceptMission(
        session.anonymousPlayerId,
        session.handle,
        offer,
        timestamp,
      );
      if (acceptance.status === 'active') {
        send(
          session.socket,
          errorMessage('MISSION_ACTIVE', 'Finish or abandon your current mission first.'),
        );
        return;
      }
      if (acceptance.status === 'completed') {
        send(
          session.socket,
          errorMessage('MISSION_COMPLETED', 'You already completed this mission today.'),
        );
        return;
      }
      profile = acceptance.profile;
      sendProgress(session, profile);
      sendMissions(session, profile);
      return;
    }

    const active = profile.activeMission;
    if (!active || active.offer.id !== message.missionId) {
      send(session.socket, errorMessage('MISSION_NOT_ACTIVE', 'That mission is not active.'));
      return;
    }
    if (timestamp - active.acceptedAtMs > MISSION_EXPIRY_MS) {
      profile = await playerStore.updateProfile(
        session.anonymousPlayerId,
        (current) => ({ ...current, activeMission: null }),
        session.handle,
      );
      sendProgress(session, profile);
      send(
        session.socket,
        errorMessage('MISSION_EXPIRED', 'That mission expired. Choose another one.'),
      );
      return;
    }
    if (message.action === 'abandon') {
      profile = await playerStore.updateProfile(
        session.anonymousPlayerId,
        (current) => ({ ...current, activeMission: null }),
        session.handle,
      );
      sendProgress(session, profile);
      sendMissions(session, profile);
      return;
    }
    if (message.action === 'start') {
      if (active.startedAtMs !== null) {
        send(session.socket, errorMessage('MISSION_STARTED', 'This mission is already underway.'));
        return;
      }
      if (
        haversineMeters(session.car.position, active.offer.pickup.location) > PICKUP_RADIUS_METERS
      ) {
        send(
          session.socket,
          errorMessage('PICKUP_TOO_FAR', 'Drive to the pickup marker to start.'),
        );
        return;
      }
      profile = await playerStore.updateProfile(
        session.anonymousPlayerId,
        (current) => ({
          ...current,
          activeMission: current.activeMission
            ? { ...current.activeMission, startedAtMs: timestamp, nextCheckpointIndex: 0 }
            : null,
        }),
        session.handle,
      );
      sendProgress(session, profile);
      return;
    }
    if (active.startedAtMs === null) {
      send(
        session.socket,
        errorMessage('MISSION_NOT_STARTED', 'Drive to the pickup marker first.'),
      );
      return;
    }
    if (message.action === 'checkpoint') {
      const checkpointIndex = message.checkpointIndex;
      const checkpoint = active.offer.checkpoints[active.nextCheckpointIndex];
      if (
        (active.offer.kind !== 'time-trial' && active.offer.kind !== 'checkpoint-race') ||
        checkpointIndex !== active.nextCheckpointIndex ||
        !checkpoint ||
        haversineMeters(session.car.position, checkpoint) > CHECKPOINT_RADIUS_METERS
      ) {
        send(
          session.socket,
          errorMessage('CHECKPOINT_ORDER', 'Reach the next checkpoint in order.'),
        );
        return;
      }
      profile = await playerStore.updateProfile(
        session.anonymousPlayerId,
        (current) => ({
          ...current,
          activeMission: current.activeMission
            ? {
                ...current.activeMission,
                nextCheckpointIndex: current.activeMission.nextCheckpointIndex + 1,
              }
            : null,
        }),
        session.handle,
      );
      sendProgress(session, profile);
      return;
    }

    if (active.nextCheckpointIndex < active.offer.checkpoints.length) {
      send(
        session.socket,
        errorMessage('CHECKPOINTS_REMAINING', 'Reach every checkpoint before finishing.'),
      );
      return;
    }
    if (
      haversineMeters(session.car.position, active.offer.destination.location) >
      FINISH_RADIUS_METERS
    ) {
      send(
        session.socket,
        errorMessage('FINISH_TOO_FAR', 'Drive to the destination marker to finish.'),
      );
      return;
    }
    const durationSeconds = Math.max(0, (timestamp - active.startedAtMs) / 1_000);
    if (durationSeconds < active.offer.minimumTimeSeconds) {
      send(session.socket, errorMessage('TIME_TOO_FAST', 'That finish was too fast to record.'));
      return;
    }
    if (durationSeconds > active.offer.timeLimitSeconds) {
      profile = await playerStore.updateProfile(
        session.anonymousPlayerId,
        (current) => ({ ...current, activeMission: null }),
        session.handle,
      );
      sendProgress(session, profile);
      send(
        session.socket,
        errorMessage('MISSION_TIMEOUT', 'Time ran out. Choose another mission.'),
      );
      return;
    }
    const completed = await playerStore.recordMissionCompletion(
      session.anonymousPlayerId,
      session.handle,
      active.offer,
      durationSeconds,
      timestamp,
    );
    if (!completed) {
      send(
        session.socket,
        errorMessage('MISSION_COMPLETED', 'This mission has already been recorded.'),
      );
      return;
    }
    sendProgress(session, completed);
    const raceId =
      active.offer.kind === 'time-trial' || active.offer.kind === 'checkpoint-race'
        ? active.offer.id
        : null;
    const snapshot = await playerStore.getLeaderboard(active.offer.areaKey, raceId);
    send(session.socket, { version: PROTOCOL_VERSION, type: 'leaderboard', snapshot });
  }

  async function handleGarageAction(
    session: Session,
    message: Extract<ClientMessage, { type: 'garage-action' }>,
  ): Promise<void> {
    let profile = await playerStore.getOrCreate(session.anonymousPlayerId, session.handle);
    if (message.action === 'repair') {
      const cost = Math.ceil(profile.damage * REPAIR_COST_CENTS_PER_DAMAGE);
      if (cost === 0) {
        send(
          session.socket,
          errorMessage('NO_REPAIR_NEEDED', 'Your vehicle is already in good condition.'),
        );
        return;
      }
      if (profile.balanceCents < cost) {
        send(
          session.socket,
          errorMessage('NOT_ENOUGH_MONEY', 'You need more money to repair this vehicle.'),
        );
        return;
      }
      profile = await playerStore.updateProfile(
        session.anonymousPlayerId,
        (current) => ({
          ...current,
          balanceCents: current.balanceCents - cost,
          damage: 0,
        }),
        session.handle,
      );
    } else {
      const vehicleId = message.vehicleId;
      if (!vehicleId || !isVehicleId(vehicleId)) {
        send(
          session.socket,
          errorMessage('VEHICLE_NOT_FOUND', 'That vehicle is not in the catalog.'),
        );
        return;
      }
      const vehicle = getVehicleDefinition(vehicleId);
      if (message.action === 'buy') {
        if (profile.ownedVehicleIds.includes(vehicleId)) {
          send(session.socket, errorMessage('VEHICLE_OWNED', 'You already own that vehicle.'));
          return;
        }
        if (profile.balanceCents < vehicle.costCents) {
          send(
            session.socket,
            errorMessage('NOT_ENOUGH_MONEY', 'Earn more mission money to buy that vehicle.'),
          );
          return;
        }
        profile = await playerStore.updateProfile(
          session.anonymousPlayerId,
          (current) => ({
            ...current,
            balanceCents: current.balanceCents - vehicle.costCents,
            ownedVehicleIds: [...current.ownedVehicleIds, vehicleId],
          }),
          session.handle,
        );
      } else {
        if (!profile.ownedVehicleIds.includes(vehicleId)) {
          send(
            session.socket,
            errorMessage('VEHICLE_NOT_OWNED', 'Buy that vehicle before selecting it.'),
          );
          return;
        }
        profile = await playerStore.updateProfile(
          session.anonymousPlayerId,
          (current) => ({ ...current, selectedVehicleId: vehicleId }),
          session.handle,
        );
        session.selectedVehicleId = vehicleId;
        session.car = { ...session.car, vehicleId };
        dirtyStates.add(session.id);
      }
    }
    session.selectedVehicleId = profile.selectedVehicleId;
    session.car = { ...session.car, vehicleId: profile.selectedVehicleId };
    sendProgress(session, profile);
  }

  async function handleDamageReport(
    session: Session,
    message: Extract<ClientMessage, { type: 'damage-report' }>,
    timestamp: number,
  ): Promise<void> {
    if (!takeWindow(session.damageTimes, timestamp, DAMAGE_REPORT_WINDOW_MS, 1)) return;
    const profile = await playerStore.getOrCreate(session.anonymousPlayerId, session.handle);
    if (message.damage <= profile.damage) return;
    const acceptedDamage = Math.min(
      message.damage,
      profile.damage + MAX_DAMAGE_INCREASE_PER_REPORT,
    );
    const updated = await playerStore.updateProfile(
      session.anonymousPlayerId,
      (current) => ({ ...current, damage: Math.max(current.damage, acceptedDamage) }),
      session.handle,
    );
    sendProgress(session, updated);
  }

  async function handleLeaderboardRequest(
    session: Session,
    message: Extract<ClientMessage, { type: 'leaderboard-request' }>,
  ): Promise<void> {
    const areaKey = tileCellAt(session.car.position, ROOM_TILE_ZOOM).key;
    const snapshot = await playerStore.getLeaderboard(areaKey, message.raceId ?? null);
    send(session.socket, { version: PROTOCOL_VERSION, type: 'leaderboard', snapshot });
  }

  function sendProgress(
    session: Session,
    profile: import('@openstreet-racer/shared').PlayerProfile,
  ): void {
    send(session.socket, { version: PROTOCOL_VERSION, type: 'progress', profile });
  }

  function sendMissions(
    session: Session,
    profile: import('@openstreet-racer/shared').PlayerProfile,
  ): void {
    send(session.socket, {
      version: PROTOCOL_VERSION,
      type: 'missions',
      offers: [...session.missionOffers.values()],
      activeMission: profile.activeMission,
    });
  }

  function sendRouteFailure(session: Session, requestId: number, message: string): void {
    send(session.socket, {
      version: PROTOCOL_VERSION,
      type: 'route-result',
      result: { requestId, ok: false, message },
    });
  }

  function heartbeat(): void {
    const timestamp = now();
    for (const [socket, session] of socketSessions) {
      if (timestamp - session.lastSeenAt > IDLE_TIMEOUT_MS) {
        socket.terminate();
        continue;
      }
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }

  function removeSession(session: Session): void {
    socketSessions.delete(session.socket);
    if (!sessions.has(session.id)) return;
    sessions.delete(session.id);
    dirtyStates.delete(session.id);
    const peers = interest.remove(session.id);
    for (const peerId of peers) {
      const peer = sessions.get(peerId);
      if (peer)
        send(peer.socket, { version: PROTOCOL_VERSION, type: 'player-left', playerId: session.id });
    }
  }

  function invalid(session: Session, code: string, message: string): void {
    session.invalidMessages += 1;
    send(session.socket, errorMessage(code, message));
    if (session.invalidMessages >= MAX_INVALID_MESSAGES || !sessions.has(session.id)) {
      session.socket.close(1008, code.slice(0, 100));
    }
  }

  async function handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
    root: string,
    playerCount: number,
    cellCount: number,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' || url.pathname === '/ready') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ status: 'ok', players: playerCount, cells: cellCount }));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const pathname = decodePath(url.pathname);
    if (pathname === null) {
      response.writeHead(400);
      response.end();
      return;
    }
    const requestedFile = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const candidate = resolve(root, `.${requestedFile}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const body = await readFile(candidate);
      const contentType =
        CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream';
      const immutable = /\.[a-f0-9_-]{8,}\./i.test(candidate);
      response.writeHead(200, {
        'content-type': contentType,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        'content-length': body.byteLength,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      if (extname(requestedFile)) {
        response.writeHead(404);
        response.end();
        return;
      }
      try {
        const index = await readFile(resolve(root, 'index.html'));
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        });
        response.end(index);
      } catch {
        response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Web app is not built. Run pnpm build first.');
      }
    }
  }

  async function listen(): Promise<{ host: string; port: number }> {
    await loadVehicleMods(resolve(webRoot, 'mods'));
    await loadVehicleMods(resolve(SERVER_DIRECTORY, '../../web/public/mods'));
    const missionMods = [
      ...(await loadMissionMods(resolve(webRoot, 'mods'))),
      ...(await loadMissionMods(resolve(SERVER_DIRECTORY, '../../web/public/mods'))),
    ];
    ambientWorld?.setMissionMods?.([...new Map(missionMods.map((mod) => [mod.id, mod])).values()]);
    await new Promise<void>((resolveListen, rejectListen) => {
      httpServer.once('error', rejectListen);
      httpServer.listen(port, host, () => {
        httpServer.off('error', rejectListen);
        resolveListen();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string')
      throw new Error('Game server did not bind a TCP port.');
    return { host: address.address, port: address.port };
  }

  async function close(): Promise<void> {
    clearInterval(broadcastTimer);
    clearInterval(heartbeatTimer);
    if (ambientTimer) clearInterval(ambientTimer);
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((resolveClose) => {
      webSocketServer.close(() => {
        if (!httpServer.listening) {
          resolveClose();
          return;
        }
        httpServer.close(() => resolveClose());
      });
    });
    await Promise.all([playerStore.close(), communityRaceStore.close()]);
  }

  return {
    httpServer,
    webSocketServer,
    listen,
    close,
    getMetrics: () => ({
      players: sessions.size,
      cells: interest.getCellCount(),
      pending: socketSessions.size,
    }),
  };
}

function takeWindow(
  entries: number[],
  timestamp: number,
  windowMs: number,
  maximum: number,
): boolean {
  let expired = 0;
  while (expired < entries.length && timestamp - entries[expired] >= windowMs) expired += 1;
  if (expired) entries.splice(0, expired);
  if (entries.length >= maximum) return false;
  entries.push(timestamp);
  return true;
}

function sendWorld(socket: WebSocket, snapshot: WorldSnapshot): void {
  let actors = snapshot.actors.slice(0, MAX_WORLD_ACTORS);
  let controls = snapshot.controls.slice(0, MAX_WORLD_CONTROLS);
  let message: ServerMessage = {
    version: PROTOCOL_VERSION,
    type: 'world',
    snapshot: { ...snapshot, actors, controls },
  };
  let payload = JSON.stringify(message);
  while (Buffer.byteLength(payload) > MAX_WORLD_MESSAGE_BYTES && actors.length > 0) {
    actors = actors.slice(0, -1);
    message = { ...message, snapshot: { ...snapshot, actors, controls } };
    payload = JSON.stringify(message);
  }
  while (Buffer.byteLength(payload) > MAX_WORLD_MESSAGE_BYTES && controls.length > 0) {
    controls = controls.slice(0, -1);
    message = { ...message, snapshot: { ...snapshot, actors, controls } };
    payload = JSON.stringify(message);
  }
  if (Buffer.byteLength(payload) > MAX_WORLD_MESSAGE_BYTES) {
    payload = JSON.stringify({
      version: PROTOCOL_VERSION,
      type: 'world',
      snapshot: { ...snapshot, actors: [], controls: [] },
    } satisfies ServerMessage);
  }
  sendSerialized(socket, payload);
}

function send(socket: WebSocket, message: ServerMessage): void {
  sendSerialized(socket, JSON.stringify(message));
}

function sendSerialized(socket: WebSocket, payload: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_SERVER_BUFFERED_BYTES) {
    socket.terminate();
    return;
  }
  socket.send(payload, (error) => {
    if (error) socket.terminate();
  });
}

function errorMessage(code: string, message: string): ServerMessage {
  return { version: PROTOCOL_VERSION, type: 'error', code, message };
}

function fallbackCar(): NetworkCarState {
  return {
    position: { ...FALLBACK_LOCATION },
    altitudeMeters: 0.6,
    velocity: { eastMetersPerSecond: 0, northMetersPerSecond: 0, upMetersPerSecond: 0 },
    headingRadians: 0,
    speedMetersPerSecond: 0,
  };
}

function readPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : fallback;
}

function readAllowedOrigins(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function startFromEnvironment(): void {
  const server = createGameServer();
  void server.listen().then(({ host, port }) => {
    console.log(`OpenStreetRacer server listening on ${host}:${port} (WS /ws)`);
  });
  const stop = (): void => {
    void server.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startFromEnvironment();
}
