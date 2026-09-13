import { equal, key } from "../shared/rules.js";

// DOM labels carry an explicit source so they can intentionally bypass the
// depth order of the 3D scene. Body picks, by contrast, follow the visible
// actor first and only use a city as a civilization shortcut.
export const PICK_SOURCES = Object.freeze({
  body: "body",
  cityLabel: "cityLabel",
  unitLabel: "unitLabel",
  tileLabel: "tileLabel",
});

const coordinateSelection = (entity, kind) => ({
  kind,
  id: entity.id,
  q: entity.q,
  r: entity.r,
});

const atPoint = (entities, point) =>
  entities.find((entity) => point?.id && entity.id === point.id) ??
  entities.find((entity) => equal(entity, point));

// Only current public observation actors enter the chooser; remembered
// contacts never masquerade as units still occupying this tile.
export function mapSelectionChoices(game, point) {
  if (!game || !point) return [];
  return [
    ...(game.units ?? []).filter((unit) => equal(unit, point))
      .map((unit) => coordinateSelection(unit, "unit")),
    ...(game.cities ?? []).filter((city) => equal(city, point))
      .map((city) => coordinateSelection(city, "city")),
  ];
}

/**
 * Resolve a map pick without consulting hidden state.
 *
 * `body` means a raycast hit in the 3D model. `cityLabel` and `unitLabel`
 * are explicit DOM nameplate picks and therefore bypass body-depth priority.
 * A body city opens its civilization card; its nameplate opens the city
 * inspector, including for observed enemy cities.
 */
export function resolveMapSelection(game, point, { source = "body" } = {}) {
  if (!game || !point) return { selection: null, civilizationId: null };
  source = point.source ?? source;

  const units = game.units ?? [];
  const cities = game.cities ?? [];
  const contacts = game.contacts ?? [];
  const cityContacts = game.cityContacts ?? [];
  const city = atPoint(cities, point);
  const unit = atPoint(units, point);
  const ownUnitAtPoint = units.find(
    (candidate) =>
      candidate.owner === game.playerId && equal(candidate, point),
  );

  if (source === PICK_SOURCES.cityLabel || point.kind === "cityLabel") {
    if (city)
      return {
        selection: coordinateSelection(city, "city"),
        civilizationId: null,
      };
    const memory = atPoint(cityContacts, point);
    if (memory)
      return {
        selection: coordinateSelection(memory, "cityContact"),
        civilizationId: null,
      };
  }

  if (source === PICK_SOURCES.unitLabel || point.kind === "unitLabel") {
    if (unit)
      return {
        selection: coordinateSelection(unit, "unit"),
        civilizationId: null,
      };
    const memory = atPoint(contacts, point);
    if (memory)
      return {
        selection: coordinateSelection(memory, "contact"),
        civilizationId: null,
      };
  }

  // A friendly garrison is rendered above its city. Preserve that visual
  // affordance for body picks, while a city nameplate above it remains an
  // explicit city selection through the branch above.
  if (source === PICK_SOURCES.body && ownUnitAtPoint)
    return {
      selection: coordinateSelection(ownUnitAtPoint, "unit"),
      civilizationId: null,
    };

  if (source === PICK_SOURCES.body && city)
    return { selection: null, civilizationId: city.owner };

  if (unit)
    return {
      selection: coordinateSelection(unit, "unit"),
      civilizationId: null,
    };
  if (city)
    return {
      selection: coordinateSelection(city, "city"),
      civilizationId: null,
    };

  const memory = atPoint(contacts, point);
  if (memory)
    return {
      selection: coordinateSelection(memory, "contact"),
      civilizationId: null,
    };
  const tile = (game.tiles ?? []).find((candidate) => equal(candidate, point));
  return {
    selection: tile
      ? { kind: "tile", q: tile.q, r: tile.r }
      : { kind: "tile", q: point.q, r: point.r },
    civilizationId: null,
  };
}

export const selectionIdentity = (selection) =>
  selection?.kind === "tile"
    ? `tile:${key(selection)}`
    : selection?.kind && selection?.id
      ? `${selection.kind}:${selection.id}`
      : null;
