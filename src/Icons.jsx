import React from "react";

const shapes = {
  pause: <path d="M10 6v20M22 6v20" />,
  play: <path d="m10 5 17 11-17 11z" />,
  walls: <path d="M3 28V5h5v5h5V5h6v5h5V5h5v23H3Zm10 0v-9h6v9" />,
  spear: (
    <>
      <path d="m6 26 15-20m-4 0 9-2-3 9m-7 6 5 4" />
      <path d="M7 12 3 16v5c0 4 4 6 6 7 2-2 4-5 4-8v-5z" />
    </>
  ),
  musket: (
    <>
      <path d="m5 27 6-7 3 2 3-4-2-2L27 4m-6 4 3 3M4 26l4 3m6-8 3 2 3-3-2-3M10 20l-3-3" />
    </>
  ),
  horse: (
    <>
      <path d="M8 28h18l-2-7-1-7 3-4-8-4-2-3-3 7-6 7 4 4 5-4 2 3-4 8M13 10l7 1" />
      <circle cx="20" cy="12" r=".8" fill="currentColor" stroke="none" />
    </>
  ),
  cannon: (
    <>
      <circle cx="12" cy="24" r="5" />
      <path d="m12 19 13 9M7 24H3m10-9L27 7l2 5-15 8-4-5zM12 21v6m-3-3h6" />
    </>
  ),
  tools: (
    <>
      <path d="M7 4 28 25l-3 3L4 7zm13 9 5-7-2-3-5 7M4 27l9-10M3 24l5 5" />
    </>
  ),
  wheat: (
    <>
      <path d="M10 28 22 4M14 20c-6 0-7-3-7-6 5 0 7 2 7 6Zm3-6c-5-1-6-4-5-7 4 1 6 3 5 7Zm-4 10c5 3 9 1 10-3-4-2-7-1-10 3Zm4-8c5 2 9 0 10-4-5-1-8 0-10 4Z" />
    </>
  ),
  people: (
    <>
      <circle cx="12" cy="10" r="4" />
      <path d="M4 27v-5c0-5 16-5 16 0v5H4Zm18-11c5 0 6 3 6 6v5h-4M22 6a4 4 0 0 1 0 8" />
    </>
  ),
  hammer: (
    <>
      <path d="m7 27 12-15m-6-3 5-6 10 8-5 6-10-8ZM5 25l4 3" />
    </>
  ),
  iron: (
    <>
      <path d="m4 22 6-12h13l6 12-9 5H9zm0 0h25M10 10l5 12m8-12-3 17" />
    </>
  ),
  niter: (
    <>
      <path d="m17 3 7 9-3 16H10L7 12l10-9Zm0 0-3 12 7 13M7 12l7 3 10-3" />
    </>
  ),
  arrow: <path d="M5 16h22m-8-8 8 8-8 8" />,
  move: (
    <>
      <path d="M16 3v26M3 16h26M12 7l4-4 4 4M12 25l4 4 4-4M7 12l-4 4 4 4m18-8 4 4-4 4" />
    </>
  ),
  target: (
    <>
      <circle cx="16" cy="16" r="9" />
      <circle cx="16" cy="16" r="3" />
      <path d="M16 2v5m0 18v5M2 16h5m18 0h5" />
    </>
  ),
  shield: (
    <>
      <path d="m16 3 11 4v9c0 6-6 11-11 13C11 27 5 22 5 16V7z" />
      <path d="m11 16 3 3 7-7" />
    </>
  ),
  city: (
    <>
      <path d="M4 28V13h8V6l5-3 5 3v12h6v10H4ZM12 28V13m10 5v10M16 9h2m-2 6h2m-2 6h2M7 18h2m-2 5h2" />
    </>
  ),
  mountain: (
    <>
      <path d="m2 27 11-22 7 14 3-7 8 15H2ZM9 13l4 3 3-4" />
    </>
  ),
  hills: <path d="M2 25c6-17 12-17 18 0m-7-3c5-10 11-10 17 3H2" />,
  layers: (
    <>
      <path d="m16 4 14 8-14 8L2 12l14-8ZM3 19l13 8 13-8" />
    </>
  ),
  plus: <path d="M16 6v20M6 16h20" />,
  minus: <path d="M6 16h20" />,
  close: <path d="m8 8 16 16M24 8 8 24" />,
  menu: (
    <>
      <circle cx="7" cy="16" r="1.7" fill="currentColor" />
      <circle cx="16" cy="16" r="1.7" fill="currentColor" />
      <circle cx="25" cy="16" r="1.7" fill="currentColor" />
    </>
  ),
  check: <path d="m6 16 7 7L27 8" />,
  clock: (
    <>
      <circle cx="16" cy="16" r="12" />
      <path d="M16 8v9l6 3" />
    </>
  ),
  info: (
    <>
      <circle cx="16" cy="16" r="12" />
      <path d="M16 14v9m0-14v1" />
    </>
  ),
  merge: (
    <>
      <path d="M5 25v-6l11-8 11 8v6M16 28V4m-5 5 5-5 5 5" />
    </>
  ),
  flag: (
    <>
      <path d="M7 29V4m0 1c6-5 11 5 18 0v14c-7 5-12-5-18 0" />
    </>
  ),
  settler: (
    <>
      <path d="M5 26V10h18v16H5Zm0-16 5-6h9l4 6M3 26h24M12 12v9m-4-4h8M25 5v12m0-11h5l-2 3 2 3h-5" />
      <circle cx="8" cy="27" r="2" />
      <circle cx="21" cy="27" r="2" />
    </>
  ),
  link: (
    <>
      <path d="m13 20-3 3a6 6 0 0 1-8-8l7-7a6 6 0 0 1 8 0m2 4 3-3a6 6 0 0 1 8 8l-7 7a6 6 0 0 1-8 0M10 22l12-12" />
    </>
  ),
  merchant: (
    <>
      <path d="M4 12h24l-2 14H6L4 12Zm3-7h18l3 7H4l3-7Z" />
      <path d="M11 5v7m10-7v7M10 18h12M12 26v-5m8 5v-5" />
    </>
  ),
  convoy: (
    <>
      <path d="M5 10h17l5 5v9H5V10Zm17 0v5h5M9 24a2.5 2.5 0 1 0 0 .1M22 24a2.5 2.5 0 1 0 0 .1" />
      <path d="M9 14h6m-3-3v6" />
    </>
  ),
};
export const unitIcon = {
  spearman: "spear",
  musketeer: "musket",
  cavalry: "horse",
  artillery: "cannon",
  builder: "tools",
  settler: "settler",
  merchant: "merchant",
  convoy: "convoy",
};
export function Icon({ name, size = 20, className = "", ...props }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      {shapes[name] ?? shapes.flag}
    </svg>
  );
}
export function UnitIcon({ type, size = 28, ...props }) {
  return <Icon name={unitIcon[type]} size={size} {...props} />;
}
