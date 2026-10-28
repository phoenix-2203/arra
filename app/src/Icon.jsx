// Small line icons, drawn for Arra (24px grid, currentColor).
const P = {
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2",
  signature: "M3 17c3-1 4-6 6-6s1 5 3 5 3-4 5-4 2 2 4 2M3 21h18",
  coins: "M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5",
  split: "M12 3v6M12 9l-6 6v6M12 9l6 6v6",
  rate: "M4 16l5-5 4 4 7-7M15 8h5v5",
  container: "M3 7h18v10H3zM7 7v10M11 7v10M15 7v10M19 7v10",
  alarm: "M12 8v5l3 2M5 3L2 6M19 3l3 3M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
  language: "M4 5h9M8.5 3v2M6 5c1 4 3.5 7 7 9M11 5c-1 4-3.5 7-7 9M13 21l4-10 4 10M14.5 17.5h5",
  sheet: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7M9 8h3",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
  code: "M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14",
  id: "M3 6h18v12H3zM7 10h4M7 14h6M16 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
  chain: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  check: "M5 12l5 5 9-10",
  arrow: "M5 12h14M13 6l6 6-6 6",
  ship: "M3 17l2 4h14l2-4M5 17V9h14v8M9 9V5h6v4",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  wallet: "M3 7h15a3 3 0 0 1 3 3v8H3zM3 7l12-4v4M16 13h2",
  plus: "M12 5v14M5 12h14",
};

export default function Icon({ name, size = 22, stroke = 1.8, className = "" }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}
