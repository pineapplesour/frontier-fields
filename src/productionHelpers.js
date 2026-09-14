import { productionType } from "../shared/rules.js";
// UI-only production arithmetic. The server remains the authority for
// affordability and completion; this helper only makes the displayed cost and
// ETA use the same units (production points, not turns).
export function productionEstimate({ cost, progress = 0, productionRate = 0 }) {
  const total = Math.max(0, Number(cost) || 0);
  const done = Math.max(0, Number(progress) || 0);
  const rate = Math.max(0, Number(productionRate) || 0);
  const remaining = Math.max(0, total - done);
  return {
    cost: total,
    progress: Math.min(done, total),
    productionRate: rate,
    remaining,
    complete: remaining <= 0,
    turns:
      remaining <= 0 ? 0 : rate > 0 ? Math.ceil(remaining / rate) : null,
  };
}

export function estimateCityProduction(city, type, definition) {
  return productionEstimate({
    cost: definition?.cost,
    // A not-yet-queued item starts from the city's banked production.
    progress:
      city?.queue === type
        ? city.production
        : Math.max(0, Number(city?.storedProduction) || 0),
    productionRate: city?.productionRate,
  });
}

// Guard against wiping a queue that already has progress with one click.
export function confirmClearProduction(city, ask = (message) => (typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(message) : true)) {
  if (!city?.queue || !((Number(city.production) || 0) > 0)) return true;
  const definition = productionType(city.queue, city);
  return ask(
    `${definition?.name ?? city.queue} 생산이 ${Math.floor(city.production)}/${definition?.cost ?? "?"}까지 진행됐어요. 정말 취소할까요? 진행도와 예약 인구가 초기화돼요.`,
  );
}
