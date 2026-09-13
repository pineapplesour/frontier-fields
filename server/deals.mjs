import { randomUUID } from "node:crypto";
import {
  FACTIONS,
  RESOURCES,
  MARKET,
  TYPES,
  equal,
  blocksUnit,
  RESOURCE_PER_POP,
} from "../shared/rules.js";
import { notifyTrade } from "./notifications.mjs";
import { isSupplyOn } from "./economy.mjs";
import {
  cityFoodCapacity,
  createFoodShipment,
  createResourceShipment,
  ensureLogisticsState,
  scheduleUnitTrade,
} from "./logistics.mjs";
const pair = (a, b) => [a, b].sort().join("|");
const factions = (g) => g.factions ?? FACTIONS;
const human = (g, p) =>
  !!g.players?.[p] &&
  g.players[p].controller !== "npc" &&
  !g.players[p].npc &&
  !["cs", "barb"].includes(p);

// `ensureLogisticsState` is intentionally called for every save so the
// observation ledger is always serializable.  Presence of that ledger alone
// must not silently opt a legacy match into physical food/resource settlement;
// only the explicit expansion ruleset (or a future explicit opt-in) does.
const physicalUnitDeals = (g) =>
  g.rulesVersion === "expansion-v1" || g.logistics?.physical === true;
const cityFor = (g, id, owner = null) => {
  const city = g.cities?.find((candidate) => candidate.id === id);
  return city && (owner == null || city.owner === owner) ? city : null;
};
const sideFood = (side) => Number(side?.food) || 0;
const sourceCityId = (side) => side?.resourceSourceCityId ?? side?.fromCityId ?? null;
const resourceDestinationId = (side) =>
  side?.resourceDestinationCityId ?? side?.toCityId ?? null;
const foodDestinationId = (side) =>
  side?.foodDestinationCityId ?? side?.foodToCityId ?? side?.destinationCityId ?? null;
const unitDestinationId = (side) =>
  side?.unitDestinationCityId ?? side?.unitToCityId ?? side?.destinationCityId ?? null;
const defaultCity = (g, owner) =>
  g.cities?.find((city) => city.owner === owner && !city.camp && city.hp > 0) ??
  g.cities?.find((city) => city.owner === owner && !city.camp) ??
  null;

function validatePhysicalSide(g, owner, recipient, side, escrow, fail) {
  if (!physicalUnitDeals(g)) return;
  if (sideFood(side) > 0) {
    if (!isSupplyOn(g)) fail("상세 보급 OFF에서는 식량 거래를 저장할 수 없어요.");
    const source = cityFor(g, side.foodCityId, owner);
    const destination = cityFor(g, foodDestinationId(side), recipient);
    if (!source || !destination)
      fail("식량 거래에는 출발·도착 도시를 모두 지정해 주세요.");
    if (!escrow && (Number(source.food) || 0) < sideFood(side))
      fail("식량 거래 출발 도시의 저장 식량이 부족해요.");
    if (sideFood(side) > cityFoodCapacity(destination))
      fail("도착 도시 식량 저장 한도를 확인해 주세요.");
  }
  for (const [resource, amount] of Object.entries(side.resources ?? {})) {
    if (!amount) continue;
    const source = cityFor(g, sourceCityId(side), owner);
    const destination = cityFor(g, resourceDestinationId(side), recipient);
    if (!source || !destination)
      fail("자원 거래에는 출발·도착 도시를 모두 지정해 주세요.");
    if (!escrow && (g.stockpiles?.[owner]?.[resource] ?? 0) < amount)
      fail("거래 자원이 부족해요.");
  }
  if (side.units.length) {
    const destination = cityFor(g, unitDestinationId(side) ?? defaultCity(g, recipient)?.id, recipient);
    if (!destination) fail("유닛 거래에는 수신 문명의 도착 도시를 지정해 주세요.");
  }
}

function escrowOutgoing(g, p) {
  const own = p.give;
  g.gold[p.from] -= own.gold;
  for (const [resource, amount] of Object.entries(own.resources))
    g.stockpiles[p.from][resource] -= amount;
  const escrow = {
    gold: own.gold,
    resources: { ...own.resources },
    food: 0,
    foodCityId: own.foodCityId ?? null,
  };
  if (physicalUnitDeals(g) && sideFood(own) > 0) {
    const city = cityFor(g, own.foodCityId, p.from);
    city.food -= sideFood(own);
    escrow.food = sideFood(own);
  }
  p.escrow = escrow;
  p.escrowed = true;
}

function physicalSnapshot(g) {
  return {
    stockpiles: structuredClone(g.stockpiles ?? {}),
    cities: new Map((g.cities ?? []).map((city) => [city.id, structuredClone(city)])),
    units: new Map((g.units ?? []).map((unit) => [unit.id, structuredClone(unit)])),
    logistics: structuredClone(g.logistics ?? {}),
  };
}

function restorePhysicalSnapshot(g, snapshot) {
  g.stockpiles = snapshot.stockpiles;
  // Physical settlement may have spawned internal convoy units before a
  // later shipment/transfer failed. Remove those new wrappers as part of the
  // same atomic rollback; leaving them in g.units would mint free actors even
  // though the shipment ledger was restored.
  const originalUnitIds = new Set(snapshot.units.keys());
  g.units = (g.units ?? []).filter((unit) => originalUnitIds.has(unit.id));
  for (const city of g.cities ?? []) {
    const saved = snapshot.cities.get(city.id);
    if (!saved) continue;
    for (const key of Object.keys(city)) delete city[key];
    Object.assign(city, saved);
  }
  for (const unit of g.units ?? []) {
    const saved = snapshot.units.get(unit.id);
    if (!saved) continue;
    for (const key of Object.keys(unit)) delete unit[key];
    Object.assign(unit, saved);
  }
  g.logistics = snapshot.logistics;
  g.cargo = g.logistics.shipments ?? [];
}

function createPhysicalDealShipments(g, p) {
  ensureLogisticsState(g);
  const shipments = [];
  for (const [side, owner, recipient, isEscrowed] of [
    [p.give, p.from, p.to, true],
    [p.receive, p.to, p.from, false],
  ]) {
    if (sideFood(side) > 0) {
      shipments.push(
        createFoodShipment(g, {
          owner,
          recipient,
          fromCityId: side.foodCityId,
          toCityId: foodDestinationId(side),
          amount: sideFood(side),
          mode: "deal-food",
          turn: g.turn,
          escrowed: isEscrowed,
          escrowId: p.id,
        }),
      );
    }
    for (const [resource, amount] of Object.entries(side.resources ?? {})) {
      if (!amount) continue;
      shipments.push(
        createResourceShipment(g, {
          owner,
          recipient,
          fromCityId: sourceCityId(side),
          toCityId: resourceDestinationId(side),
          resource,
          amount,
          mode: "deal-resource",
          turn: g.turn,
          escrowed: isEscrowed,
          escrowId: p.id,
        }),
      );
    }
  }
  return shipments;
}

function transferDealUnits(g, p) {
  const transfers = [];
  for (const [side, from, to] of [
    [p.give, p.from, p.to],
    [p.receive, p.to, p.from],
  ]) {
    for (const id of side.units) {
      const destination = cityFor(
        g,
        unitDestinationId(side) ?? defaultCity(g, to)?.id,
        to,
      );
      if (!destination) throw new Error("유닛 거래 도착 도시가 없어요.");
      transfers.push(
        scheduleUnitTrade(g, {
          unitId: id,
          fromOwner: from,
          recipient: to,
          toCityId: destination.id,
          turn: g.turn,
        }),
      );
    }
  }
  return transfers;
}
export function refundDeal(g, p) {
  if (p.refunded === true || p.settled === true) return false;
  g.gold ??= {};
  g.gold[p.from] ??= 0;
  g.stockpiles ??= {};
  g.stockpiles[p.from] ??= {};
  g.gold[p.from] += p.give.gold;
  for (const [r, n] of Object.entries(p.give.resources))
    g.stockpiles[p.from][r] += n;
  // Food offered by a human is escrowed from the named city.  A rejected or
  // cancelled proposal returns it to that same city; it is never refunded to
  // a national or hidden pool.
  const foodEscrow = Number(p.escrow?.food) || 0;
  if (foodEscrow > 0) {
    const city = g.cities?.find(
      (candidate) => candidate.id === p.escrow.foodCityId && candidate.owner === p.from,
    );
    if (city) city.food = (Number(city.food) || 0) + foodEscrow;
  }
  p.refunded = true;
  return true;
}
export function dealEntitiesValid(g, p) {
  return [
    [p.from, p.give],
    [p.to, p.receive],
  ].every(
    ([owner, side]) =>
      side.units.every((id) =>
        g.units.some((u) => u.id === id && u.owner === owner && u.hp > 0),
      ) &&
      side.cities.every((id) =>
        g.cities.some((c) => c.id === id && c.owner === owner && c.hp > 0),
      ),
  );
}
export function handleDeal(
  g,
  player,
  raw,
  {
    GameError,
    event,
    atWar,
    relation,
    announceWar,
    npcWarRisk = null,
    preview = false,
  },
) {
  const fail = (text) => {
    throw new GameError(text);
  };
  const checkWar = (who, against, partner) => {
    if (!against) return;
    if (
      !factions(g)[against] ||
      [who, partner, "barb"].includes(against) ||
      atWar(g, who, against)
    )
      fail("참전 대상은 아직 전쟁 중이 아닌 제3문명이어야 해요.");
    if (
      (g.peaceUntil[pair(who, against)] ?? 0) >= g.turn ||
      relation(g, who, against) === "alliance"
    )
      fail("참전 대상과 평화 협정 또는 동맹 중이에요.");
    if (
      npcWarRisk &&
      g.players?.[who]?.controller === "npc" &&
      raw.observation?.playerId === who
    ) {
      const own = npcWarRisk(raw.observation, who).targetStrength,
        risk = npcWarRisk(raw.observation, against);
      if (own < risk.coalitionStrength * 1.1)
        fail("공개된 보장 연합까지 고려하면 참전 위험이 너무 커요.");
    }
  };
  const validate = (p, escrow) => {
    if (atWar(g, p.from, p.to) && !p.peace)
      fail("전쟁 중에는 평화 협정 조건을 포함해 주세요.");
    if (!dealEntitiesValid(g, p))
      fail(
        "거래 대상 도시·유닛의 소유권 또는 상태가 바뀌었어요. 제안을 취소해 주세요.",
      );
    checkWar(p.from, p.give.warAgainst, p.to);
    checkWar(p.to, p.receive.warAgainst, p.from);
    if (
      p.alliance &&
      [p.from, p.to].some(
        (who) => (g.denouncements[pair(p.from, p.to)] ?? 0) >= g.turn,
      )
    )
      fail("공개비난이 지속되는 동안에는 동맹할 수 없어요.");
    for (const [owner, s, skip] of [
      [p.from, p.give, escrow],
      [p.to, p.receive, false],
    ])
      if (!skip) {
        if (
          g.gold[owner] < s.gold ||
          Object.entries(s.resources).some(
            ([r, n]) => g.stockpiles[owner][r] < n,
          )
        )
          fail("거래 조건을 지불할 수 없어요.");
      }
    for (const [owner, outgoing, incoming, held] of [
      [p.from, p.give, p.receive, escrow],
      [p.to, p.receive, p.give, false],
    ]) {
      const capacity = g.cities
        .filter(
          (c) =>
            incoming.cities.includes(c.id) ||
            (c.owner === owner && !outgoing.cities.includes(c.id)),
        )
        .reduce((n, c) => n + c.population * RESOURCE_PER_POP, 0);
      for (const r of Object.keys(RESOURCES)) {
        const before =
          g.stockpiles[owner][r] + (held ? (outgoing.resources[r] ?? 0) : 0);
        const after =
          before - (outgoing.resources[r] ?? 0) + (incoming.resources[r] ?? 0);
        if (after > capacity && after > before)
          fail(
            "거래 후 자원 비축 한도를 초과해요. 자원을 줄이거나 먼저 판매해 주세요.",
          );
      }
    }
    validatePhysicalSide(g, p.from, p.to, p.give, escrow, fail);
    validatePhysicalSide(g, p.to, p.from, p.receive, false, fail);
    const ownership = (u) =>
      p.give.units.includes(u.id)
        ? p.to
        : p.receive.units.includes(u.id)
          ? p.from
          : u.owner;
    for (const u of g.units.filter(
      (u) => p.give.units.includes(u.id) || p.receive.units.includes(u.id),
    ))
      if (
        g.units.some(
          (v) =>
            v.id !== u.id &&
            equal(u, v) &&
            blocksUnit(
              { ...u, owner: ownership(u) },
              { ...v, owner: ownership(v) },
            ),
        )
      )
        fail(
          "겹쳐 있는 유닛은 함께 넘기거나 다른 타일로 이동한 뒤 거래해 주세요.",
        );
  };
  const settle = (p) => {
    if (p.settled === true) return;
    validate(p, true);
    const physical = physicalUnitDeals(g);
    const snapshot = physical ? physicalSnapshot(g) : null;
    try {
      if (physical) {
        // Resource/food inventory was escrowed only for the proposing side.
        // Both sides become shipments atomically; no destination receives an
        // instant credit and the unit itself remains at its current tile.
        createPhysicalDealShipments(g, p);
        transferDealUnits(g, p);
      }
    } catch (error) {
      if (snapshot) restorePhysicalSnapshot(g, snapshot);
      fail(error?.message ?? "물리 거래를 준비하지 못했어요.");
    }
    if (p.peace) {
      g.wars = g.wars.filter((k) => k !== pair(p.from, p.to));
      g.peaceUntil[pair(p.from, p.to)] = g.turn + 5;
    }
    g.gold[p.to] += p.give.gold - p.receive.gold;
    g.gold[p.from] += p.receive.gold;
    if (!physical)
      for (const r of Object.keys(RESOURCES)) {
        g.stockpiles[p.to][r] +=
          (p.give.resources[r] ?? 0) - (p.receive.resources[r] ?? 0);
        g.stockpiles[p.from][r] += p.receive.resources[r] ?? 0;
      }
    for (const [side, from, to] of [
      [p.give, p.from, p.to],
      [p.receive, p.to, p.from],
    ]) {
      if (side.openBorders) {
        g.openBorders ??= {};
        g.openBorders[`${from}>${to}`] = g.turn + 30;
      }
      if (!physical)
        for (const id of side.units) {
          const u = g.units.find((u) => u.id === id);
          u.owner = to;
          // Legacy settlement retains the historical source while making the
          // new controller authoritative for later manpower actions.
          if (Number.isFinite(u.manpowerCost)) u.manpowerOwner = to;
          u.order = null;
          u.movesLeft = 0;
          u.attackUsed = true;
          u.acted = true;
          u.fortified = false;
          u.fortifyPending = false;
        }
      for (const id of side.cities) {
        const c = g.cities.find((c) => c.id === id);
        c.owner = to;
        c.attackUsed = true;
        for (const t of g.tiles.filter((t) => t.cityId === id)) t.owner = to;
      }
      if (side.warAgainst) {
        const k = pair(from, side.warAgainst);
        if (!g.wars.includes(k)) g.wars.push(k);
        announceWar(g, from, side.warAgainst);
      }
    }
    if (p.alliance) g.alliances[pair(p.from, p.to)] = g.turn + 10;
    g.relations[pair(p.from, p.to)] =
      (g.relations[pair(p.from, p.to)] ?? 0) + 15;
    p.settled = true;
    p.settledTurn = g.turn;
    event(
      g,
      [p.from, p.to],
      "거래가 성립했어요. 도시·유닛·자원·외교 조건을 함께 이전했어요.",
    );
  };
  if (
    ["acceptProposal", "rejectProposal", "cancelProposal"].includes(raw.action)
  ) {
    const p = g.proposals.find(
      (p) => p.id === raw.proposalId && p.kind === "deal",
    );
    if (!p) return false;
    if (raw.action === "cancelProposal" ? p.from !== player : p.to !== player)
      fail("응답할 수 없는 거래 제안이에요.");
    if (raw.action === "acceptProposal") settle(p);
    else refundDeal(g, p);
    g.proposals = g.proposals.filter((x) => x.id !== p.id);
    notifyTrade(
      g,
      p,
      raw.action === "acceptProposal"
        ? "accepted"
        : raw.action === "cancelProposal"
          ? "cancelled"
          : "rejected",
    );
    return true;
  }
  if (raw.action !== "offerDeal") return false;
  const to = raw.factionId;
  if (!factions(g)[to] || to === player || to === "barb")
    fail("거래 가능한 문명을 선택해 주세요.");
  if (g.proposals.some((p) => pair(p.from, p.to) === pair(player, to)))
    fail("기존 제안에 먼저 응답해 주세요.");
  const side = (s) => {
    s ??= {};
    if (s.openBorders !== undefined && typeof s.openBorders !== "boolean")
      fail("국경개방 조건은 켜기 또는 끄기로 지정해 주세요.");
    const gold = s.gold ?? 0,
      resources = s.resources ?? {},
      units = s.units ?? [],
      cities = s.cities ?? [],
      foodValue =
        s.food && typeof s.food === "object" ? s.food.amount ?? 0 : s.food ?? s.foodAmount ?? 0;
    if (
      !Number.isInteger(gold) ||
      gold < 0 ||
      gold > 10000 ||
      !Number.isFinite(Number(foodValue)) ||
      Number(foodValue) < 0 ||
      Number(foodValue) > 100000 ||
      !resources ||
      typeof resources !== "object" ||
      Array.isArray(resources) ||
      Object.entries(resources).some(
        ([r, n]) =>
          !Object.hasOwn(RESOURCES, r) ||
          !Number.isInteger(n) ||
          n < 0 ||
          n > 100,
      ) ||
      ![units, cities].every(
        (a) =>
          Array.isArray(a) &&
          a.length <= 40 &&
          a.every((id) => typeof id === "string") &&
          new Set(a).size === a.length,
      )
    )
      fail("거래 항목이나 수량이 올바르지 않아요.");
    return {
      gold,
      resources: { ...resources },
      units: [...units],
      cities: [...cities],
      food: Number(foodValue),
      foodCityId:
        s.foodCityId ??
        (s.food && typeof s.food === "object" ? s.food.cityId : null),
      foodDestinationCityId:
        s.foodDestinationCityId ??
        s.foodToCityId ??
        (s.food && typeof s.food === "object" ? s.food.destinationCityId : null),
      resourceSourceCityId: s.resourceSourceCityId ?? s.fromCityId ?? null,
      resourceDestinationCityId: s.resourceDestinationCityId ?? s.toCityId ?? null,
      unitDestinationCityId: s.unitDestinationCityId ?? s.unitToCityId ?? s.destinationCityId ?? null,
      warAgainst: s.warAgainst ?? null,
      openBorders: s.openBorders === true,
    };
  };
  const p = {
    id: randomUUID(),
    kind: "deal",
    from: player,
    to,
    give: side(raw.give),
    receive: side(raw.receive),
    alliance: raw.alliance === true,
    peace: raw.peace === true,
    expires: g.turn + 3,
  };
  if (
    !p.alliance &&
    !p.peace &&
    [p.give, p.receive].every(
      (s) =>
        !s.gold &&
        !sideFood(s) &&
        !Object.values(s.resources).some(Boolean) &&
        !s.units.length &&
        !s.cities.length &&
        !s.warAgainst && !s.openBorders,
    )
  ) {
    if (preview)
      return {
        status: "empty",
        message: "양쪽 목록에서 거래할 항목을 골라 주세요.",
        additionalGold: null,
      };
    fail("제안에 거래 항목을 넣어 주세요.");
  }
  // A human offer may request assets the partner lacks; do not disclose private stock.
  const own = p.give;
  if (
    (g.gold[player] ?? 0) < own.gold ||
    Object.entries(own.resources).some(([r, n]) => (g.stockpiles[player]?.[r] ?? 0) < n)
  )
    fail("내가 제공할 골드·자원이 부족해요.");
  // This checks only the offerer's own stock and route declarations.  The
  // partner's private stock remains undisclosed until acceptance.
  validatePhysicalSide(g, player, to, own, false, fail);
  if (!dealEntitiesValid(g, p)) fail("거래 가능한 도시·유닛을 확인해 주세요.");
  const visible = raw.observation;
  if (
    p.receive.units.some(
      (id) => !visible.units.some((u) => u.id === id && u.owner === to),
    ) ||
    p.receive.cities.some(
      (id) =>
        !visible.cities.some((c) => c.id === id && c.owner === to && !c.ghost),
    )
  )
    fail("현재 관측한 상대 도시·유닛만 요청할 수 있어요.");
  checkWar(player, p.give.warAgainst, to);
  checkWar(to, p.receive.warAgainst, player);
  if (atWar(g, player, to) && !p.peace)
    fail("전쟁 중에는 평화 협정 조건을 포함해 주세요.");
  if (p.alliance && (g.denouncements[pair(player, to)] ?? 0) >= g.turn)
    fail("공개비난 중에는 동맹을 맺을 수 없어요.");
  p.labels = Object.fromEntries(
    [...g.units, ...g.cities]
      .filter((e) =>
        [
          ...p.give.units,
          ...p.receive.units,
          ...p.give.cities,
          ...p.receive.cities,
        ].includes(e.id),
      )
      .map((e) => [e.id, e.name ?? `${TYPES[e.type].name} ×${e.size}`]),
  );
  // Only specifically offered assets are voluntarily disclosed to the counterpart.
  // NPC valuation reads these contract disclosures, not unseen rival world state.
  p.assets = Object.fromEntries(
    [...g.units, ...g.cities]
      .filter((e) => Object.hasOwn(p.labels, e.id))
      .map((e) => [
        e.id,
        e.type
          ? { type: e.type, hp: e.hp, size: e.size, xp: e.xp }
          : {
              population: e.population,
              capital: e.capital,
              wallLevel: e.wallLevel ?? 0,
              hp: e.hp,
            },
      ]),
  );
  const value = (s) =>
    s.gold +
    Object.entries(s.resources).reduce(
      (v, [r, n]) => v + MARKET[r].sell * n,
      0,
    ) +
    s.units.reduce((v, id) => v + TYPES[p.assets[id].type].cost * 2, 0) +
    s.cities.reduce((v, id) => {
      const c = p.assets[id];
      return v + 150 + (c.population ?? 1) * 25 + (c.capital ? 150 : 0);
    }, 0) +
    (s.warAgainst ? 60 : 0) + (s.openBorders ? 30 : 0);
  const additionalGold = Math.max(
    0,
    Math.ceil(
      value(p.receive) +
        (p.alliance && relation(g, player, to) !== "good" ? 30 : 0) +
        (p.peace ? 40 : 0) -
        value(p.give),
    ),
  );
  if (preview) {
    if (human(g, to))
      return {
        status: "human",
        message: "사람이 조종하는 상대예요. 직접 수락해야 성립해요.",
        additionalGold: null,
      };
    try {
      validate(p, false);
    } catch {
      return {
        status: "unavailable",
        message:
          "상대가 현재 이 조건을 이행할 수 없어요. 요청 항목을 조정해 주세요.",
        additionalGold: null,
      };
    }
    return {
      status: additionalGold ? "insufficient" : "accept",
      additionalGold,
      canAfford: g.gold[player] >= own.gold + additionalGold,
      message: additionalGold
        ? `골드 ${additionalGold}를 더 제시하면 수락해요.`
        : "현재 조건을 수락할 의향이 있어요.",
    };
  }
  if (!human(g, to)) {
    if (additionalGold > 0) {
      event(
        g,
        [player],
        `${factions(g)[to].name}이 거래를 거절했어요. 참전·도시·유닛의 가치에 맞는 대가가 필요해요.`,
      );
      notifyTrade(g, p, "rejected");
      return true;
    }
    try {
      validate(p, false);
    } catch {
      event(
        g,
        [player],
        `${factions(g)[to].name}이 현재 거래 조건을 수락하지 못했어요.`,
      );
      notifyTrade(g, p, "rejected");
      return true;
    }
  }
  escrowOutgoing(g, p);
  if (human(g, to)) {
    g.proposals.push(p);
    notifyTrade(g, p, "requested");
    event(
      g,
      [player, to],
      "도시·유닛·외교 조건이 포함된 거래 제안이 도착했어요.",
    );
  } else {
    settle(p);
    notifyTrade(g, p, "accepted");
  }
  return true;
}
