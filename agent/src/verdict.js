// Arra's read on a supplier: one level and the plain reasons behind it.
//
// Rules, not a model: the same facts always give the same answer, and every reason can
// be checked by the buyer (a link, a number, a transaction). The AI only helps decide
// which public posts are real complaints about this seller.
//
// Levels: "risk" (something is clearly wrong), "careful" (warning signs), "good"
// (established, nothing wrong found), "unknown" (too little to go on).
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function verdict({ profile = null, complaints = null, proof = null, payTo = null, payToPages = [], record = null, reviews = null, walletTxs = null } = {}) {
  const bad = [];
  const warn = [];
  const good = [];
  const info = [];
  const handle = profile?.handle ?? proof?.handle ?? null;
  const label = profile?.label ?? "";

  // Who controls the page, compared with who gets paid. The strongest signal there is.
  if (proof && payTo) {
    if (proof.address.toLowerCase() === payTo.toLowerCase()) good.push(`@${proof.handle} is confirmed: the owner of that page put Arra's code in their bio from this same wallet.`);
    else bad.push(`@${proof.handle} was confirmed by a different wallet (${short(proof.address)}). The wallet you're paying (${short(payTo)}) is not the page owner's. This is how impersonation scams work.`);
  } else if (payTo && handle && payToPages.length && !payToPages.some((x) => x.handle === handle)) {
    warn.push(`The wallet you're paying confirmed a different page (@${payToPages[0].handle} on ${payToPages[0].label}), not @${handle}. Ask them why before you pay.`);
  } else if (!proof && payTo && payToPages.length) {
    good.push(`This wallet belongs to the owner of @${payToPages[0].handle} on ${payToPages[0].label} (confirmed on Arra).`);
  } else if (proof) {
    good.push(`@${proof.handle} has been confirmed by its owner for wallet ${short(proof.address)}. Make sure that's the wallet you pay.`);
  }

  if (profile) {
    const s = profile.summary;
    if (!profile.found) warn.push(`No public ${label} account named @${profile.handle}. Check the spelling, or ask them for the exact name of their page.`);
    else {
      for (const f of profile.flags) warn.push(f);
      if (!profile.flags.length && s.followers >= 1000 && s.posts >= 30) good.push(`Established ${label} page: ${s.followers.toLocaleString("en-US")} followers, ${s.posts.toLocaleString("en-US")} posts.`);
      else if (!profile.flags.length) {
        const facts = [s.followers !== null ? `${s.followers.toLocaleString("en-US")} followers` : null, s.posts !== null ? `${s.posts.toLocaleString("en-US")} posts` : null, s.createdAt ? `on ${label} since ${new Date(s.createdAt * 1000).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}` : null].filter(Boolean);
        if (s.followers === null && s.posts >= 100 && s.createdAt && Date.now() / 1000 - s.createdAt > 365 * 86400) good.push(`Active ${label} page: ${facts.join(", ")}.`);
        else if (facts.length) info.push(`${label} page: ${facts.join(", ")}.`);
      }
    }
  }

  if (complaints) {
    const n = complaints.complaints.length;
    // Only posts the AI confirmed are a customer's complaint about this seller can make the
    // verdict "high risk". Without that check, a match is shown as a warning to read.
    if (n >= 2 && complaints.judged) bad.push(`${n} public posts from customers accuse this seller (read them below).`);
    else if (n === 1 && complaints.judged) warn.push("One public post from a customer accuses this seller (read it below).");
    else if (n) warn.push(`${n === 1 ? "One public post uses" : `${n} public posts use`} words like "scam" next to this seller's name. ${n === 1 ? "It may not be" : "They may not be"} about them; read below.`);
    else info.push(`No public complaints found on ${complaints.searched.map((x) => (x === "x" ? "X" : "Reddit")).join(" or ")}. That helps, but it doesn't prove they're honest.`);
  }

  if (record) {
    if (record.refundedUnshipped > 0) bad.push(`On Arra, this wallet took a deposit and didn't ship ${record.refundedUnshipped === 1 ? "once" : `${record.refundedUnshipped} times`}.`);
    if (record.paid >= 1) good.push(`${record.paid} order${record.paid === 1 ? "" : "s"} completed on Arra.`);
    if (record.disputed >= 2 && record.disputed * 2 > record.accepted) warn.push(`Buyers raised a problem on ${record.disputed} of ${record.accepted} orders on Arra.`);
  }

  if (reviews?.count) {
    const [yes, all] = reviews.again;
    if (all >= 2 && yes / all < 0.5) bad.push(`Only ${yes} of ${all} buyers would order from them again.`);
    else if (all && yes / all < 0.8) warn.push(`${all - yes} of ${all} buyers wouldn't order from them again.`);
    else good.push(`${reviews.count} review${reviews.count === 1 ? "" : "s"} from ${reviews.people} buyer${reviews.people === 1 ? "" : "s"}, ${yes} of ${all} would order again.`);
  }

  if (payTo && walletTxs === 0 && !(record?.accepted > 0)) info.push("Their wallet has never made a transaction. That's normal for someone new to crypto; consider a smaller deposit for a first order.");

  const level = bad.length ? "risk" : warn.length ? "careful" : good.length ? "good" : "unknown";
  return {
    level,
    handle,
    reasons: [...bad.map((t) => ({ tone: "bad", text: t })), ...warn.map((t) => ({ tone: "warn", text: t })), ...good.map((t) => ({ tone: "good", text: t })), ...info.map((t) => ({ tone: "info", text: t }))],
  };
}
