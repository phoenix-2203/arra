// Free check that the AI can sort complaints from noise (no payment, uses the AI key in .env).
// npm run judge-test
import { assistant } from "../src/assistant.js";

const ai = assistant();
if (!ai.enabled) {
  console.log("No AI key in .env (GEMINI_API_KEY or ANTHROPIC_API_KEY).");
  process.exit(1);
}
const posts = [
  { source: "x", author: "ada_buys", text: "@quickdeals.ng collected my 250k deposit for 2 iPhones and blocked me. Scam, don't buy!" },
  { source: "x", author: "quickdeals.ng_fan", text: "Beware of fake pages copying @quickdeals.ng, they only sell on this page" },
  { source: "reddit", author: "tunde", text: "quickdeals.ng never delivered my phones, now asking for more money for 'customs'." },
  { source: "x", author: "news", text: "Police warn about scams in Lagos markets this December" },
];
console.log(`AI: ${ai.provider}`);
const keep = await ai.judgeComplaints({ handle: "quickdeals.ng", name: "Quick Deals NG", posts });
console.log("Kept posts:", keep, "(expected [0, 2])");
for (const i of keep ?? []) console.log(` - ${posts[i].text}`);
