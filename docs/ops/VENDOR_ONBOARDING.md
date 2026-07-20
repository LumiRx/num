# NUM — Vendor Onboarding Guide (Thai ground team)

**Goal:** 40+ real Phuket merchants in NUM's catalogue before pilot launch. NUM only recommends what's in this catalogue — it never invents places. Every quality merchant you add makes the AI smarter; every empty category makes it say "I don't have anyone for that yet."

**คู่มือนี้สำหรับทีมภาคสนาม:** เก็บข้อมูลร้านค้า/บริการจริงในภูเก็ตลงชีตเดียว แล้วทีมเทคจะโหลดเข้าระบบให้

---

## The workflow

1. Collect merchants in one shared Google Sheet using the exact columns of [`vendor_template.csv`](./vendor_template.csv) (copy row 1 as your header).
2. One row = one merchant. Fill what you can — `name` + `category` are required, everything else raises quality.
3. When a batch is ready: File → Download → CSV, send it to Dre.
4. Tech runs `python scripts/ingest_vendors.py batch.csv --dry-run` (validation preview), then live. Re-sending an updated sheet is safe — existing merchants get updated, not duplicated.

## The columns · คอลัมน์

| Column | What to put · ใส่อะไร | Required |
|---|---|---|
| `name` | Official name, EN spelling the merchant uses · ชื่อร้านตามที่ร้านใช้จริง | ✅ |
| `category` | One of: `restaurant` `hotel` `transfer` `tour` `spa` `school` `agent` `activity` `nightlife` `shopping` `medical` `other` | ✅ |
| `area` | Neighborhood · ย่าน (Patong, Chalong, Old Town, Kata, Rawai…) | strong |
| `price_band` | `฿` cheap · `฿฿` mid · `฿฿฿` upscale · `฿฿฿฿` luxury | strong |
| `hours` | e.g. `11:00-22:00`, `24h`, `Mon-Sat 10:00-19:00` | strong |
| `phone` | With +66 · เบอร์โทรพร้อมรหัสประเทศ | strong |
| `line_id` / `whatsapp` / `wechat_id` | Whichever the merchant actually answers · ช่องทางที่ร้านตอบจริง | strong |
| `photos_url` | Link to a Drive folder of 3–5 real photos you took · ลิงก์รูปถ่ายจริง 3–5 รูป | strong |
| `maps_url` | Google Maps share link | nice |
| `website` | If real and current | nice |
| `languages` | Staff languages: `th,en,zh,ru` · ภาษาที่พนักงานพูดได้ | nice |
| `commission_pct` | Agreed commission % — leave blank until agreed · เปอร์เซ็นต์ค่าคอมที่ตกลงแล้วเท่านั้น | later |
| `featured_tier` | Leave blank. `local`/`standard`/`premium` is a business decision after commission talks | later |
| `notes` | The gold: what makes it good, who it suits, insider tips · จุดเด่น เหมาะกับใคร ทิปพิเศษ | strong |
| `lat`,`lng` | From Google Maps (right-click → copy coordinates) | nice |

## Quality bar · มาตรฐานคุณภาพ

- **Real only.** You (or someone you trust) have been there or spoken to the owner. NUM's reputation dies on one bad recommendation.
- **Notes sell it.** "Seafood restaurant" is weak. "Family-run, on the water, live tanks, Chinese menu, free pier pickup" is what makes NUM sound like a local friend.
- **Answering channel matters.** A merchant who never answers LINE is a dead end for bookings — note the channel they actually respond on.
- **Spread across categories.** Target for pilot: ~10 restaurants, 5 spas, 5 tours/activities, 5 transfers, 3–5 hotels, plus 5+ in whale-adjacent categories (`agent`, `school`, `medical`).

## Priorities this week · ลำดับความสำคัญ

1. Merchants near partner vehicle routes (airport ↔ Patong/Kata/Karon).
2. Places with Chinese- or Russian-speaking staff (biggest tourist segments).
3. Whale-adjacent: real-estate agents, international schools, visa agents, private hospitals — one good `agent` row can be worth more than fifty restaurants.

## Test conversations · ทดสอบแชท

Once your batch is loaded, message NUM and ask for what you just added — in Thai. Check: does it recommend the right place? Are names/details right? Does the Thai sound natural? Report anything that feels off (screenshot + one line on what's wrong) — that feedback tunes the AI's voice before tourists ever see it.
