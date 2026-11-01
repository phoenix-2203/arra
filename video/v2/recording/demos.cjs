// Records every app demo for the film, as one continuous story: check the supplier, describe the
// order, send the link, supplier agrees (in Chinese) and confirms their page, lock, accept, ship,
// arrival, a look at the problem form, pay, reviews and the receipt.
const { stage } = require('./rec-lib.cjs');
const { execSync } = require('child_process');
const V = require('./vault.json').vault;
const BASE = 'http://localhost:8791';
const mine = () => execSync(`~/.foundry/bin/cast rpc --rpc-url http://127.0.0.1:8545 anvil_mine 3`, { stdio: 'pipe' });
(async () => {
  const B = await stage('buyer');
  const S = await stage('supplier', { browser: B.b, lang: 'zh' });
  const { p } = B;

  // ---- 1 check a supplier
  await p.goto(`${BASE}/check`); await B.w(1000);
  await B.start(); B.mark('in');
  await B.caption('Example shop, made up for this demo');
  await B.type('input[placeholder^="@phoenix"]', 'instagram.com/gadgetplug.ng', 45);
  await B.click('form button.money'); B.mark('red_click');
  await p.waitForSelector('.v-risk', { timeout: 20000 }); B.mark('red');
  await B.w(300); await B.scroll('.verdict'); await B.to('.v-head', 800); await B.w(1200);
  await B.scroll('.v-reasons'); await B.to('.v-posts', 800); B.mark('posts'); await B.w(2400);
  await B.caption(''); await B.scroll(0); await B.w(700);
  await B.click('button[role=radio]:has-text("X")', 550);
  await p.locator('input[placeholder^="@phoenix"]').fill('');
  await B.type('input[placeholder^="@phoenix"]', 'shiproafrica', 55);
  await B.click('form button.money'); B.mark('green_click');
  await p.waitForSelector('.v-good', { timeout: 20000 }); B.mark('green');
  await B.w(300); await B.scroll('.verdict'); await B.to('.v-reasons', 800); await B.w(2600); B.mark('end');
  await B.stop('check');

  // ---- 2 describe the order
  await p.goto(`${BASE}/new`); await B.w(1200);
  await B.start(); B.mark('in');
  await B.click('.ai-open', 700); await B.w(400);
  await B.type('.ai-input textarea, .ai-input input', '20 Samsung Galaxy A15 phones from Phoenix Store, $14 each, 128GB black, 10 per carton, ship by 15 December', 22);
  await B.click('.ai-input button[type=submit]', 500); B.mark('sent');
  await p.waitForSelector('text=Check the order', { timeout: 20000 }); await B.w(900); B.mark('answer');
  await B.click('button:has-text("Check the order")', 600); await B.w(1400); B.mark('form');
  const colour = '.detail-row input >> nth=1';
  await B.scroll('.detail-row', 200); await B.w(700);
  await B.click(colour, 700); await p.keyboard.press('End');
  await p.locator(colour).pressSequentially(', good quality', { delay: 55 }); B.mark('vague');
  await p.waitForSelector('.issues', { timeout: 8000 }); await B.w(300);
  await B.to('.issues', 700); await B.w(2600); B.mark('issue_shown');
  await B.click(colour, 400); for (let i = 0; i < 14; i++) await p.keyboard.press('Backspace');
  await B.w(900); await B.to('button:has-text("Next")', 700); await B.w(600); B.mark('end');
  await B.stop('describe');

  // ---- 3 one link (buyer), supplier agrees in Chinese, then confirms their page
  await B.start(); B.mark('in');
  await B.click('button:has-text("Next")', 500); await B.w(900);
  await B.click('button:has-text("Create the link")', 700); await B.w(1300);
  const link = await p.inputValue('input[readonly]');
  await B.to('input[readonly]', 600); await B.w(1500); B.mark('end');
  await B.stop('link-a');

  await S.p.goto(link); await S.w(1500);
  await S.start(); S.mark('in');
  await S.scroll('.terms', 140); await S.to('.terms', 900); await S.w(1800);
  await S.click('button.money', 800); S.mark('agreed'); await S.w(2000); S.mark('end');
  await S.stop('link-b');

  await S.p.goto(link.replace(/(\?.*)?$/, '?lang=en')); await S.w(1500);
  await S.scroll('summary', 300); await S.w(500);
  await S.start(); S.mark('in');
  await S.click('summary:has-text("Page confirmed")', 700); await S.w(600);
  await S.type('input[placeholder="@username"]', 'phoenix.store', 55);
  await S.click('button:has-text("Get my code")', 500); await S.w(900); S.mark('code');
  const code = (await S.p.textContent('.proof-code strong')).trim();
  await S.to('.proof-code strong', 700); await S.w(1500);
  await fetch('http://localhost:8799/__bio', { method: 'POST', body: JSON.stringify({ 'phoenix.store': `Phones wholesale, Shenzhen · ${code}` }) });
  await S.click('button:has-text("check now")', 700); S.mark('checking');
  await S.p.waitForSelector('.note.ok:has-text("confirmed")', { timeout: 20000 }); S.mark('confirmed'); await S.w(2600); S.mark('end');
  await S.stop('proof');

  await B.w(4500); // the buyer's page notices the agreement and checks the supplier by itself
  await B.start(); B.mark('in');
  await B.scroll(0); await B.w(400);
  await B.to('.note.ok', 700); await B.w(1500);
  if (await p.locator('.v-line').count()) { await B.to('.v-line', 700); await B.w(1500); }
  if (await p.locator('details.rv-line summary').count()) { await B.click('details.rv-line summary', 700); await B.w(2600); }
  B.mark('end');
  await B.stop('link-c');

  // ---- 4 lock, supplier accepts
  await B.start(); B.mark('in');
  await B.click('button:has-text("Next")', 600); await B.w(1500);
  await B.scroll('button.money:has-text("Lock")', 400); await B.w(500);
  await B.click('button.money:has-text("Lock")', 800); B.mark('lock_click');
  await p.waitForURL(/\/o\/[A-Za-z0-9]{10}/, { timeout: 40000 }); await B.w(2000); B.mark('locked');
  await B.w(1500); B.mark('end');
  await B.stop('lock-a');
  const orderUrl = p.url().split('?')[0];

  await S.p.goto(`${orderUrl}?lang=zh`); await S.w(2000);
  await S.start(); S.mark('in');
  await S.scroll('button.money', 300); await S.w(500);
  await S.click('button.money', 800); S.mark('accept_click');
  await S.p.waitForSelector('text=已接单', { timeout: 30000 }).catch(() => {}); await S.w(800);
  await S.scroll(0); await S.w(1800); S.mark('end');
  await S.stop('lock-b');
  mine();

  // ---- 5 ship (supplier, English), arrival + a look at the problem form + pay (buyer)
  await S.p.goto(`${orderUrl}?lang=en`); await S.w(2000);
  await S.start(); S.mark('in');
  await S.scroll('input.num', 300); await S.w(400);
  await S.type('input.num', 'CSQU 305438 2', 60); S.mark('bad'); await S.w(1300);
  for (let i = 0; i < 1; i++) await S.p.keyboard.press('Backspace');
  await S.p.locator('input.num').first().pressSequentially('3', { delay: 80 }); S.mark('good'); await S.w(900);
  await S.click('button:has-text("Mark as shipped")', 700); S.mark('ship_click');
  await S.p.waitForSelector('text=Marked as shipped', { timeout: 30000 }).catch(() => {}); await S.w(1500); S.mark('end');
  await S.stop('ship-a');
  mine();

  await p.goto(orderUrl); await B.w(2200);
  await B.start(); B.mark('in');
  await B.scroll('button:has-text("Goods arrived")', 300); await B.w(400);
  await B.click('button:has-text("Goods arrived")', 800); B.mark('arrived_click');
  await p.waitForSelector('button:has-text("Something")', { timeout: 30000 }); await B.w(1200); B.mark('arrived');
  await B.click('button:has-text("Something")', 700); B.mark('problem'); await B.w(900);
  await B.scroll('.problem, form', 150).catch(() => {}); await B.w(600);
  await B.to('textarea', 700); await B.w(1300);
  if (await p.locator('text=Add photo').count()) { await B.to('text=Add photo', 600); await B.w(1100); }
  await B.click('button:has-text("Cancel")', 700); B.mark('problem_end'); await B.w(900);
  await B.scroll('button:has-text("Everything")', 300); await B.w(400);
  await B.click('button:has-text("Everything")', 800); B.mark('pay_click');
  await p.waitForSelector('text=Balance paid', { timeout: 30000 }).catch(() => {}); await B.w(1000);
  await B.scroll(0); await B.w(1800); B.mark('end');
  await B.stop('ship-b');
  mine(); mine();

  // ---- 6 reviews: supplier writes first (not recorded), buyer writes, both appear; receipt
  await S.p.goto(`${orderUrl}?lang=en`); await S.w(2500);
  const sy = S.p.locator('.review-ask .yn');
  for (let i = 0; i < await sy.count(); i++) await sy.nth(i).locator('button').first().click();
  await S.p.click('button:has-text("Sign and post review")'); await S.w(1500);
  await p.goto(orderUrl); await B.w(2500);
  await B.start(); B.mark('in');
  await B.scroll('.review-ask', 160); await B.w(500);
  const yn = p.locator('.review-ask .yn');
  for (let i = 0; i < await yn.count(); i++) await B.click(`.review-ask .yn >> nth=${i} >> button >> nth=0`, 550);
  await B.type('.review-ask textarea', 'Shipped early, phones exactly as described.', 35);
  await B.click('button:has-text("Sign and post review")', 700); B.mark('posted');
  await p.waitForSelector('.reviews', { timeout: 20000 }); await B.w(400);
  await B.scroll('.reviews', 160); await B.to('.reviews', 700); await B.w(2600); B.mark('revealed');
  await B.scroll(0); await B.w(500);
  await B.click('a:has-text("Receipt")', 800); await B.w(2600); B.mark('end');
  await B.stop('after');

  await B.b.close();
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
