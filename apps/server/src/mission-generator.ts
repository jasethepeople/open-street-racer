import type { LonLat, MissionKind, MissionOffer, MissionPlace } from '@openstreet-racer/shared';
import { MAX_ROUTE_DISTANCE_METERS, ROOM_TILE_ZOOM } from '@openstreet-racer/shared';
import {
  buildRoadGraph,
  findRoute,
  haversineMeters,
  localMetersToLonLat,
  lonLatToLocalMeters,
  nearestRoadNode,
  tileCellAt,
  type OsmElement,
  type OsmNodeElement,
  type OsmRelationElement,
  type OsmWayElement,
  type RoadGraph,
} from '@openstreet-racer/world';

const MAX_OFFER_COUNT = 8;
const MAX_MISSION_ROUTE_POINTS = 10;
const MIN_ROUTE_DISTANCE_METERS = 300;
const MAX_PLACE_DISTANCE_METERS = 7_000;
const ROAD_SNAP_DISTANCE_METERS = 450;
const MISSION_KINDS: readonly MissionKind[] = ['delivery', 'taxi', 'time-trial', 'checkpoint-race'];

export interface CommunityRoutePlan {
  readonly points: readonly LonLat[];
  readonly distanceMeters: number;
  readonly travelTimeSeconds: number;
}

export function createCommunityRaceOffer(
  id: string,
  title: string,
  creatorHandle: string,
  start: LonLat,
  destination: LonLat,
  routePlan: CommunityRoutePlan,
): MissionOffer | null {
  const distanceMeters = Math.round(
    routePlan.distanceMeters +
      haversineMeters(start, routePlan.points[0] ?? start) +
      haversineMeters(routePlan.points.at(-1) ?? destination, destination),
  );
  if (
    distanceMeters < MIN_ROUTE_DISTANCE_METERS ||
    distanceMeters > MAX_ROUTE_DISTANCE_METERS ||
    routePlan.points.length < 2
  ) {
    return null;
  }
  const interiorPoints = routePlan.points.filter((point, index) => {
    const isFirstEndpoint = index === 0 && haversineMeters(start, point) < 5;
    const isLastEndpoint =
      index === routePlan.points.length - 1 && haversineMeters(destination, point) < 5;
    return !isFirstEndpoint && !isLastEndpoint;
  });
  const route = [start, ...interiorPoints, destination];
  const checkpointPoints = route.slice(1, -1);
  if (!checkpointPoints.length) {
    const destinationLocal = lonLatToLocalMeters(destination, start);
    checkpointPoints.push(
      localMetersToLonLat({ x: destinationLocal.x / 2, y: destinationLocal.y / 2 }, start),
    );
  }
  return {
    id,
    source: 'community',
    creatorHandle,
    kind: 'checkpoint-race',
    title: `Community race · ${title}`,
    areaKey: tileCellAt(start, ROOM_TILE_ZOOM).key,
    pickup: { id: `${id}:start`, name: `${title} start`, category: 'start', location: start },
    destination: {
      id: `${id}:finish`,
      name: `${title} finish`,
      category: 'finish',
      location: destination,
    },
    route: samplePoints(route, 24),
    checkpoints: samplePoints(checkpointPoints, 3),
    distanceMeters,
    minimumTimeSeconds: Math.max(10, Math.ceil(routePlan.travelTimeSeconds * 0.45)),
    timeLimitSeconds: Math.max(90, Math.ceil(routePlan.travelTimeSeconds * 2.2 + 45)),
    rewardCents: Math.min(10_000, Math.max(500, Math.round(500 + distanceMeters * 0.4))),
  };
}

export function generateMissionOffers(
  elements: readonly OsmElement[],
  location: LonLat,
  nowMs = Date.now(),
): readonly MissionOffer[] {
  const areaKey = tileCellAt(location, ROOM_TILE_ZOOM).key;
  const graph = buildRoadGraph(elements, location, 'vehicle');
  const places = collectPlaces(elements)
    .filter((place) => haversineMeters(location, place.location) <= MAX_PLACE_DISTANCE_METERS)
    .sort(
      (first, second) =>
        haversineMeters(location, first.location) - haversineMeters(location, second.location),
    )
    .slice(0, 12);
  const candidates = places.length >= 2 ? places : collectRoadPlaces(graph, location);
  if (candidates.length < 2) return [];

  const seed = new Date(nowMs).toISOString().slice(0, 10);
  const offers: MissionOffer[] = [];
  const usedPairs = new Set<string>();
  for (let index = 0; index < MISSION_KINDS.length && offers.length < MAX_OFFER_COUNT; index += 1) {
    const kind = MISSION_KINDS[index]!;
    let offer: MissionOffer | null = null;
    for (let shift = 0; shift < candidates.length && !offer; shift += 1) {
      const first = candidates[(index + shift) % candidates.length]!;
      for (let offset = 1; offset < candidates.length; offset += 1) {
        const second = candidates[(index + shift + offset) % candidates.length]!;
        const pairKey = `${first.id}|${second.id}`;
        if (first.id === second.id || usedPairs.has(pairKey)) continue;
        offer = createOffer(graph, first, second, kind, areaKey, seed);
        if (offer) usedPairs.add(pairKey);
        if (offer) break;
      }
    }
    if (offer) offers.push(offer);
  }

  if (offers.length < MAX_OFFER_COUNT && candidates.length >= 2) {
    for (let index = 0; index < candidates.length && offers.length < MAX_OFFER_COUNT; index += 1) {
      const first = candidates[index]!;
      const second = candidates[(index + 1) % candidates.length]!;
      const kind = MISSION_KINDS[offers.length % MISSION_KINDS.length]!;
      const offer = createOffer(graph, first, second, kind, areaKey, seed);
      if (offer && !offers.some((existing) => existing.id === offer?.id)) offers.push(offer);
    }
  }

  return offers;
}

function createOffer(
  graph: RoadGraph,
  pickup: MissionPlace,
  destination: MissionPlace,
  kind: MissionKind,
  areaKey: string,
  seed: string,
): MissionOffer | null {
  const start = nearestRoadNode(graph, pickup.location, ROAD_SNAP_DISTANCE_METERS);
  const end = nearestRoadNode(graph, destination.location, ROAD_SNAP_DISTANCE_METERS);
  if (!start || !end || start.node.id === end.node.id) return null;
  const roadRoute = findRoute(graph, start.node.id, end.node.id);
  if (
    !roadRoute ||
    roadRoute.distanceMeters < MIN_ROUTE_DISTANCE_METERS ||
    roadRoute.distanceMeters > MAX_ROUTE_DISTANCE_METERS
  ) {
    return null;
  }
  const title = missionTitle(kind, pickup, destination);
  return {
    id: `mission-${hash(`${seed}:${areaKey}:${kind}:${pickup.id}:${destination.id}`)}`,
    kind,
    title,
    areaKey,
    pickup,
    destination,
    route: samplePoints(roadRoute.points, MAX_MISSION_ROUTE_POINTS),
    checkpoints: createCheckpoints(kind, roadRoute.points),
    distanceMeters: Math.round(roadRoute.distanceMeters),
    minimumTimeSeconds: Math.max(10, Math.ceil(roadRoute.travelTimeSeconds * 0.45)),
    timeLimitSeconds: Math.max(90, Math.ceil(roadRoute.travelTimeSeconds * 2.2 + 45)),
    rewardCents: Math.min(10_000, Math.max(500, Math.round(500 + roadRoute.distanceMeters * 0.4))),
  };
}

function collectPlaces(elements: readonly OsmElement[]): MissionPlace[] {
  const nodes = new Map<string, OsmNodeElement>();
  const ways = new Map<string, OsmWayElement>();
  for (const element of elements) {
    if (element.type === 'node') nodes.set(String(element.id), element);
    else if (element.type === 'way') ways.set(String(element.id), element);
  }
  const places: MissionPlace[] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    const tags = stringTags(element.tags);
    const category = placeCategory(tags);
    if (!category) continue;
    const place =
      element.type === 'node'
        ? nodePlace(element, category)
        : element.type === 'way'
          ? wayPlace(element, nodes, category)
          : relationPlace(element, ways, nodes, category);
    if (!place || seen.has(place.id)) continue;
    seen.add(place.id);
    places.push(place);
  }
  return places;
}

function stringTags(
  tags: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function nodePlace(node: OsmNodeElement, category: string): MissionPlace {
  const location = { longitude: node.lon, latitude: node.lat };
  return {
    id: `node-${node.id}`,
    name: safePlaceName(node.tags?.name, category, node.id),
    category,
    location,
  };
}

function wayPlace(
  way: OsmWayElement,
  nodes: ReadonlyMap<string, OsmNodeElement>,
  category: string,
): MissionPlace | null {
  const location = centroid(wayPoints(way, nodes));
  if (!location) return null;
  return {
    id: `way-${way.id}`,
    name: safePlaceName(way.tags?.name, category, way.id),
    category,
    location,
  };
}

function relationPlace(
  relation: OsmRelationElement,
  ways: ReadonlyMap<string, OsmWayElement>,
  nodes: ReadonlyMap<string, OsmNodeElement>,
  category: string,
): MissionPlace | null {
  const outerWays = relation.members.filter(
    (member) => member.type === 'way' && (member.role === 'outer' || !member.role),
  );
  const memberWays = outerWays.length
    ? outerWays
    : relation.members.filter((member) => member.type === 'way');
  const points = memberWays.flatMap((member) => {
    const way = ways.get(String(member.ref));
    return way ? wayPoints(way, nodes) : [];
  });
  const location = centroid(points);
  if (!location) return null;
  return {
    id: `relation-${relation.id}`,
    name: safePlaceName(relation.tags?.name, category, relation.id),
    category,
    location,
  };
}

function wayPoints(way: OsmWayElement, nodes: ReadonlyMap<string, OsmNodeElement>): LonLat[] {
  const points = way.nodes
    .map((id) => nodes.get(String(id)))
    .filter((node): node is OsmNodeElement => Boolean(node))
    .map((node) => ({ longitude: node.lon, latitude: node.lat }));
  if (
    points.length > 2 &&
    points[0]?.longitude === points[points.length - 1]?.longitude &&
    points[0]?.latitude === points[points.length - 1]?.latitude
  ) {
    points.pop();
  }
  return points;
}

function centroid(points: readonly LonLat[]): LonLat | null {
  if (!points.length) return null;
  return points.reduce(
    (center, point) => ({
      longitude: center.longitude + point.longitude / points.length,
      latitude: center.latitude + point.latitude / points.length,
    }),
    { longitude: 0, latitude: 0 },
  );
}

function collectRoadPlaces(graph: RoadGraph, location: LonLat): MissionPlace[] {
  return [...graph.nodes.values()]
    .filter((node) => haversineMeters(location, node.location) <= MAX_PLACE_DISTANCE_METERS)
    .sort(
      (first, second) =>
        haversineMeters(location, first.location) - haversineMeters(location, second.location),
    )
    .slice(0, 16)
    .map((node, index) => ({
      id: `road-${node.id}`,
      name: index === 0 ? 'Nearby intersection' : `Street checkpoint ${index + 1}`,
      category: 'street',
      location: node.location,
    }));
}

function placeCategory(tags: Readonly<Record<string, string>>): string | null {
  if (tags.shop) return 'shop';
  if (
    tags.leisure === 'park' ||
    tags.leisure === 'playground' ||
    tags.leisure === 'sports_centre'
  ) {
    return 'park';
  }
  if (/^(school|college|university|kindergarten)$/u.test(tags.amenity ?? '')) return 'school';
  if (/^(restaurant|cafe|fast_food|pub|bar)$/u.test(tags.amenity ?? '')) return 'restaurant';
  if (/^(hospital|clinic|pharmacy|bank|fuel|marketplace)$/u.test(tags.amenity ?? '')) {
    return tags.amenity === 'fuel' ? 'fuel station' : (tags.amenity ?? 'place');
  }
  if (tags.tourism === 'museum' || tags.tourism === 'attraction') return 'attraction';
  return null;
}

function safePlaceName(value: string | undefined, category: string, id: number | string): string {
  const normalized = value
    ?.replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 72);
  return normalized || `${titleCase(category)} ${String(id).slice(-5)}`;
}

function missionTitle(kind: MissionKind, pickup: MissionPlace, destination: MissionPlace): string {
  const prefix = {
    delivery: 'Delivery',
    taxi: 'Taxi fare',
    'time-trial': 'Time trial',
    'checkpoint-race': 'Checkpoint race',
  }[kind];
  return `${prefix} · ${pickup.name} → ${destination.name}`;
}

function createCheckpoints(kind: MissionKind, route: readonly LonLat[]): readonly LonLat[] {
  if ((kind !== 'time-trial' && kind !== 'checkpoint-race') || route.length < 2) return [];
  const interior = route.slice(1, -1);
  return samplePoints(interior.length ? interior : [route.at(-1)!], 3);
}

function samplePoints(points: readonly LonLat[], maximum: number): readonly LonLat[] {
  if (points.length <= maximum) return points.map((point) => ({ ...point }));
  return Array.from({ length: maximum }, (_, index) => {
    const point = points[Math.round((index * (points.length - 1)) / (maximum - 1))]!;
    return { ...point };
  });
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function hash(value: string): string {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(36);
}
