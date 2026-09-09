// Screen-space presentation only. Never changes tile coordinates or picking
// identity. Stable input order keeps labels still when a selection changes.
export function layoutMapLabels(labels, width, height) {
  const placed = [];
  const overlaps = (a, b) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 4 && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + 4;
  for (const label of [...labels].sort((a, b) => a.priority - b.priority)) {
    let chosen = { ...label };
    let found = false;
    for (let ring = 0; ring <= 12 && !found; ring++) {
      const count = ring ? Math.max(8, ring * 8) : 1;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
        const candidate = {
          ...label,
          x: Math.min(width - label.width / 2 - 6, Math.max(label.width / 2 + 6, label.x + Math.cos(angle) * ring * 12)),
          y: Math.min(height - label.height / 2 - 6, Math.max(label.height / 2 + 6, label.y + Math.sin(angle) * ring * 12)),
        };
        if (!placed.some(other => overlaps(candidate, other))) {
          chosen = candidate;
          found = true;
          break;
        }
      }
    }
    placed.push(chosen);
  }
  return placed;
}
