// Display only this player's public economy; no independent unit inference.
export function resourceFlow(economy, resource) {
  const gross = economy?.income?.[resource] ?? 0;
  const upkeep = economy?.resourceUpkeep?.[resource] ?? 0;
  const net = economy?.netResourceIncome?.[resource] ?? gross - upkeep;
  return { gross, upkeep, net, signed: `${net >= 0 ? "+" : ""}${net}` };
}
