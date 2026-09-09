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
    progress: city?.queue === type ? city.production : 0,
    productionRate: city?.productionRate,
  });
}
