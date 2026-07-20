/**
 * LumiRX bulk-load helper — paste this into the browser console at admin.aeroz.io
 * AFTER api.lumirx.com is back online and responding 2xx to authenticated calls.
 *
 * What it does:
 *   1. Pulls your auth token straight from localStorage (no copy-paste).
 *   2. POSTs the seed data to api.lumirx.com endpoints in dependency order:
 *        Brands → Sellers → Locations → Products → Tags
 *   3. Prints per-record outcome to the console.
 *
 * IMPORTANT — before running:
 *   - Confirm api.lumirx.com is healthy (try GET /brand/getAllBrands and check for 200).
 *   - Submit ONE record via the UI first so you can copy the EXACT POST shape into
 *     the *_payload() functions below. The seed JSON closely matches the GET shapes,
 *     but POST shapes may differ (e.g. nested objects vs. flat fields).
 *   - You can dry-run by setting DRY_RUN = true near the top.
 */

const DRY_RUN = true; // flip to false to actually create records

// --- get auth token ----------------------------------------------------
function getToken() {
  const raw = localStorage.getItem("persist:root");
  if (!raw) throw new Error("Not logged in — no persist:root in localStorage.");
  const root = JSON.parse(raw);
  const auth = JSON.parse(root.authReducer);
  return auth.accessToken;
}

const API = "https://api.lumirx.com";

async function api(method, path, body) {
  const token = getToken();
  if (DRY_RUN) {
    console.log(`[DRY] ${method} ${path}`, body);
    return { dry: true };
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ok: res.ok, body: json };
}

// --- payload shapers (ADJUST after you see one real POST) ---------------

// brand → POST /brand/createBrand   (endpoint name is a guess; check Network tab)
function brandPayload(b) {
  return {
    brandName: b.displayName,
    parentCompany: b.legalName,
    businessEntityName: b.legalName,
    businessRegistrationNumber: b.gln ?? "",
    address: {
      line1: b._addressLine1 ?? "",
      line2: "",
      country: b.country === "US" ? "United States" : b.country,
      city: b._city ?? "",
      state: b._state ?? "",
      zip: b._zip ?? "",
    },
    primaryProductCategory: b.industry,
    description: b.notes ?? "",
  };
}

// product → POST /product/createProduct
function productPayload(p) {
  return {
    brandId: p._brandId,            // resolved at runtime, see runProducts()
    price: p.value?.amount ?? 0,
    name: p.name,
    category: p.category,
    gtin: p.gtin ?? p.sku ?? "",
    description: p.description ?? "",
  };
}

// seller → POST /seller/createSeller   (schema unknown — fill in once mapped)
function sellerPayload(s) {
  return {
    name: s.displayName,
    legalName: s.legalName,
    industry: s.industry,
    tier: s.tier,
    contactName: s.primaryContact?.name,
    contactEmail: s.primaryContact?.email,
    contactPhone: s.primaryContact?.phone,
    status: s.status,
  };
}

// location → POST /location/createLocation
function locationPayload(l) {
  return {
    name: l.name,
    type: l.type,
    sellerId: l._sellerId,           // resolved at runtime
    address: l.address,
    latitude: l.geo?.lat,
    longitude: l.geo?.lng,
    capabilities: l.capabilities,
    status: l.status,
  };
}

// tag → POST /tag/createTag
function tagPayload(t) {
  return {
    epc: t.epc,
    productId: t._productId,         // resolved at runtime
    tagType: t.tagType,
    frequency: t.frequency,
    status: t.currentStatus,
    parentTagId: t._parentTagId ?? null,
  };
}

// --- run pipeline -------------------------------------------------------

async function loadSeed(seed) {
  console.group("LumiRX seed loader");
  console.log("DRY_RUN =", DRY_RUN, "— flip to false to actually create.");

  // 1. Brands
  console.group("Brands");
  const brandIdMap = {};
  for (const b of seed.brands ?? []) {
    const r = await api("POST", "/brand/createBrand", brandPayload(b));
    brandIdMap[b._seedKey] = r.body?.id ?? "DRY";
    console.log(b.displayName, "→", r.status ?? "DRY", brandIdMap[b._seedKey]);
  }
  console.groupEnd();

  // 2. Sellers
  console.group("Sellers");
  const sellerIdMap = {};
  for (const s of seed.sellers ?? []) {
    const r = await api("POST", "/seller/createSeller", sellerPayload(s));
    sellerIdMap[s.sellerId] = r.body?.id ?? "DRY";
    console.log(s.displayName, "→", r.status ?? "DRY", sellerIdMap[s.sellerId]);
  }
  console.groupEnd();

  // 3. Locations
  console.group("Locations");
  const locIdMap = {};
  for (const l of seed.locations ?? []) {
    l._sellerId = sellerIdMap[l.sellerId];
    const r = await api("POST", "/location/createLocation", locationPayload(l));
    locIdMap[l.locationId] = r.body?.id ?? "DRY";
    console.log(l.name, "→", r.status ?? "DRY", locIdMap[l.locationId]);
  }
  console.groupEnd();

  // 4. Products
  console.group("Products");
  const prodIdMap = {};
  for (const p of seed.products ?? []) {
    p._brandId = brandIdMap[p._brandKey];        // map product → brand
    const r = await api("POST", "/product/createProduct", productPayload(p));
    prodIdMap[p.productId] = r.body?.id ?? "DRY";
    console.log(p.name, "→", r.status ?? "DRY", prodIdMap[p.productId]);
  }
  console.groupEnd();

  // 5. Tags
  console.group("Tags");
  for (const t of seed.tags ?? []) {
    t._productId = prodIdMap[t.productId];
    t._parentTagId = t.parentTagId ? null : null; // resolve later if you want parent-child
    const r = await api("POST", "/tag/createTag", tagPayload(t));
    console.log(t.epc, "→", r.status ?? "DRY");
  }
  console.groupEnd();

  console.log("Done.");
  console.groupEnd();
}

// --- usage --------------------------------------------------------------
// Paste the seed JSON inline OR fetch it from a Gist / local server.
// Example:
//   const seed = await (await fetch("https://your-gist/aeroz_demo_combined.json")).json();
//   await loadSeed(seed);

console.log("Bulk-load helper loaded. Call loadSeed(seedJson) when ready.");
