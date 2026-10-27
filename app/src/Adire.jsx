// Background cloth for the order panel, after adire eleko patterns:
// rows of resist-dyed rings and stitched dots on indigo.
export function Cloth() {
  return (
    <svg className="cloth" aria-hidden="true" preserveAspectRatio="xMidYMid slice" viewBox="0 0 360 240">
      <defs>
        <pattern id="adire" width="60" height="60" patternUnits="userSpaceOnUse">
          <circle cx="30" cy="30" r="17" fill="none" stroke="#3b49a3" strokeWidth="2.2" />
          <circle cx="30" cy="30" r="9" fill="none" stroke="#33419a" strokeWidth="2" />
          <circle cx="30" cy="30" r="2.6" fill="#3b49a3" />
          <g fill="#2c3990">
            <circle cx="0" cy="0" r="2" /><circle cx="60" cy="0" r="2" />
            <circle cx="0" cy="60" r="2" /><circle cx="60" cy="60" r="2" />
            <circle cx="30" cy="0" r="1.4" /><circle cx="30" cy="60" r="1.4" />
            <circle cx="0" cy="30" r="1.4" /><circle cx="60" cy="30" r="1.4" />
          </g>
        </pattern>
        <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1e2a78" stopOpacity="0.96" />
          <stop offset="0.55" stopColor="#1e2a78" stopOpacity="0.55" />
          <stop offset="1" stopColor="#1e2a78" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="360" height="240" fill="url(#adire)" />
      <rect width="360" height="240" fill="url(#fade)" />
    </svg>
  );
}

/** The two linked r's of the wordmark: buyer and supplier, joined by the deal. */
export function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="Arra home">
      A<span className="rr" aria-hidden="true"><span>r</span><span>r</span></span>a
    </a>
  );
}
