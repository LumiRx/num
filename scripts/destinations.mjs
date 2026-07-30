/**
 * NUM · global destination registry
 * bbox = [south, west, north, east]  (Overpass order)
 * Add a row here and the ingester picks it up on the next run.
 */
export const DESTINATIONS = [
  // ─── UK & Ireland ───────────────────────────────────────────────
  { slug:'london',      name:'London',        country:'GB', region:'UK',     tz:'Europe/London',    lat:51.507, lng:-0.128, bbox:[51.44,-0.24,51.57,-0.02] },
  { slug:'edinburgh',   name:'Edinburgh',     country:'GB', region:'UK',     tz:'Europe/London',    lat:55.953, lng:-3.188, bbox:[55.92,-3.25,55.98,-3.13] },
  { slug:'manchester',  name:'Manchester',    country:'GB', region:'UK',     tz:'Europe/London',    lat:53.480, lng:-2.242, bbox:[53.44,-2.30,53.52,-2.17] },
  { slug:'liverpool',   name:'Liverpool',     country:'GB', region:'UK',     tz:'Europe/London',    lat:53.408, lng:-2.991, bbox:[53.37,-3.03,53.44,-2.93] },
  { slug:'bath',        name:'Bath',          country:'GB', region:'UK',     tz:'Europe/London',    lat:51.380, lng:-2.360, bbox:[51.36,-2.40,51.41,-2.32] },
  { slug:'dublin',      name:'Dublin',        country:'IE', region:'UK',     tz:'Europe/Dublin',    lat:53.350, lng:-6.260, bbox:[53.31,-6.33,53.39,-6.19] },

  // ─── Europe ─────────────────────────────────────────────────────
  { slug:'paris',       name:'Paris',         country:'FR', region:'Europe', tz:'Europe/Paris',     lat:48.857, lng:2.352,  bbox:[48.81,2.23,48.91,2.44] },
  { slug:'nice',        name:'Nice',          country:'FR', region:'Europe', tz:'Europe/Paris',     lat:43.700, lng:7.265,  bbox:[43.66,7.19,43.74,7.32] },
  { slug:'rome',        name:'Rome',          country:'IT', region:'Europe', tz:'Europe/Rome',      lat:41.903, lng:12.496, bbox:[41.85,12.42,41.96,12.58] },
  { slug:'venice',      name:'Venice',        country:'IT', region:'Europe', tz:'Europe/Rome',      lat:45.440, lng:12.336, bbox:[45.40,12.27,45.47,12.39] },
  { slug:'florence',    name:'Florence',      country:'IT', region:'Europe', tz:'Europe/Rome',      lat:43.771, lng:11.256, bbox:[43.74,11.19,43.81,11.31] },
  { slug:'milan',       name:'Milan',         country:'IT', region:'Europe', tz:'Europe/Rome',      lat:45.464, lng:9.190,  bbox:[45.42,9.11,45.51,9.26] },
  { slug:'barcelona',   name:'Barcelona',     country:'ES', region:'Europe', tz:'Europe/Madrid',    lat:41.385, lng:2.173,  bbox:[41.34,2.09,41.44,2.24] },
  { slug:'madrid',      name:'Madrid',        country:'ES', region:'Europe', tz:'Europe/Madrid',    lat:40.417, lng:-3.704, bbox:[40.37,-3.78,40.48,-3.62] },
  { slug:'seville',     name:'Seville',       country:'ES', region:'Europe', tz:'Europe/Madrid',    lat:37.389, lng:-5.984, bbox:[37.35,-6.03,37.42,-5.94] },
  { slug:'lisbon',      name:'Lisbon',        country:'PT', region:'Europe', tz:'Europe/Lisbon',    lat:38.722, lng:-9.139, bbox:[38.69,-9.21,38.79,-9.08] },
  { slug:'porto',       name:'Porto',         country:'PT', region:'Europe', tz:'Europe/Lisbon',    lat:41.158, lng:-8.629, bbox:[41.13,-8.68,41.19,-8.57] },
  { slug:'amsterdam',   name:'Amsterdam',     country:'NL', region:'Europe', tz:'Europe/Amsterdam', lat:52.370, lng:4.895,  bbox:[52.33,4.81,52.42,4.98] },
  { slug:'berlin',      name:'Berlin',        country:'DE', region:'Europe', tz:'Europe/Berlin',    lat:52.520, lng:13.405, bbox:[52.46,13.29,52.56,13.50] },
  { slug:'munich',      name:'Munich',        country:'DE', region:'Europe', tz:'Europe/Berlin',    lat:48.137, lng:11.575, bbox:[48.10,11.49,48.18,11.65] },
  { slug:'vienna',      name:'Vienna',        country:'AT', region:'Europe', tz:'Europe/Vienna',    lat:48.208, lng:16.373, bbox:[48.16,16.29,48.25,16.44] },
  { slug:'prague',      name:'Prague',        country:'CZ', region:'Europe', tz:'Europe/Prague',    lat:50.088, lng:14.420, bbox:[50.04,14.34,50.13,14.51] },
  { slug:'budapest',    name:'Budapest',      country:'HU', region:'Europe', tz:'Europe/Budapest',  lat:47.498, lng:19.040, bbox:[47.45,18.97,47.55,19.12] },
  { slug:'copenhagen',  name:'Copenhagen',    country:'DK', region:'Europe', tz:'Europe/Copenhagen',lat:55.677, lng:12.568, bbox:[55.64,12.50,55.72,12.65] },
  { slug:'stockholm',   name:'Stockholm',     country:'SE', region:'Europe', tz:'Europe/Stockholm', lat:59.329, lng:18.069, bbox:[59.29,17.98,59.37,18.15] },
  { slug:'zurich',      name:'Zurich',        country:'CH', region:'Europe', tz:'Europe/Zurich',    lat:47.377, lng:8.542,  bbox:[47.34,8.47,47.42,8.61] },
  { slug:'athens',      name:'Athens',        country:'GR', region:'Europe', tz:'Europe/Athens',    lat:37.984, lng:23.728, bbox:[37.94,23.66,38.02,23.80] },
  { slug:'dubrovnik',   name:'Dubrovnik',     country:'HR', region:'Europe', tz:'Europe/Zagreb',    lat:42.650, lng:18.094, bbox:[42.62,18.05,42.68,18.15] },
  { slug:'reykjavik',   name:'Reykjavik',     country:'IS', region:'Europe', tz:'Atlantic/Reykjavik',lat:64.147,lng:-21.933,bbox:[64.10,-22.02,64.18,-21.80] },
  { slug:'istanbul',    name:'Istanbul',      country:'TR', region:'Europe', tz:'Europe/Istanbul',  lat:41.008, lng:28.978, bbox:[40.97,28.90,41.07,29.09] },

  // ─── Asia ───────────────────────────────────────────────────────
  { slug:'phuket',      name:'Phuket',        country:'TH', region:'Asia',   tz:'Asia/Bangkok',     lat:7.953,  lng:98.338, bbox:[7.72,98.22,8.22,98.48] },
  { slug:'bangkok',     name:'Bangkok',       country:'TH', region:'Asia',   tz:'Asia/Bangkok',     lat:13.756, lng:100.501,bbox:[13.68,100.45,13.82,100.62] },
  { slug:'chiang-mai',  name:'Chiang Mai',    country:'TH', region:'Asia',   tz:'Asia/Bangkok',     lat:18.788, lng:98.985, bbox:[18.73,98.93,18.84,99.04] },
  { slug:'koh-samui',   name:'Koh Samui',     country:'TH', region:'Asia',   tz:'Asia/Bangkok',     lat:9.512,  lng:100.014,bbox:[9.40,99.90,9.61,100.11] },
  { slug:'krabi',       name:'Krabi',         country:'TH', region:'Asia',   tz:'Asia/Bangkok',     lat:8.060,  lng:98.845, bbox:[7.95,98.74,8.15,98.96] },
  { slug:'pattaya',     name:'Pattaya',       country:'TH', region:'Asia',   tz:'Asia/Bangkok',     lat:12.927, lng:100.877,bbox:[12.85,100.83,13.00,100.95] },
  { slug:'tokyo',       name:'Tokyo',         country:'JP', region:'Asia',   tz:'Asia/Tokyo',       lat:35.681, lng:139.767,bbox:[35.62,139.67,35.73,139.83] },
  { slug:'kyoto',       name:'Kyoto',         country:'JP', region:'Asia',   tz:'Asia/Tokyo',       lat:35.011, lng:135.768,bbox:[34.96,135.70,35.06,135.83] },
  { slug:'osaka',       name:'Osaka',         country:'JP', region:'Asia',   tz:'Asia/Tokyo',       lat:34.694, lng:135.502,bbox:[34.64,135.44,34.73,135.56] },
  { slug:'seoul',       name:'Seoul',         country:'KR', region:'Asia',   tz:'Asia/Seoul',       lat:37.566, lng:126.978,bbox:[37.49,126.90,37.60,127.08] },
  { slug:'singapore',   name:'Singapore',     country:'SG', region:'Asia',   tz:'Asia/Singapore',   lat:1.290,  lng:103.852,bbox:[1.23,103.76,1.38,103.93] },
  { slug:'hong-kong',   name:'Hong Kong',     country:'HK', region:'Asia',   tz:'Asia/Hong_Kong',   lat:22.302, lng:114.170,bbox:[22.24,114.11,22.35,114.25] },
  { slug:'taipei',      name:'Taipei',        country:'TW', region:'Asia',   tz:'Asia/Taipei',      lat:25.038, lng:121.565,bbox:[24.99,121.49,25.10,121.62] },
  { slug:'kuala-lumpur',name:'Kuala Lumpur',  country:'MY', region:'Asia',   tz:'Asia/Kuala_Lumpur',lat:3.147,  lng:101.700,bbox:[3.08,101.63,3.20,101.76] },
  { slug:'hanoi',       name:'Hanoi',         country:'VN', region:'Asia',   tz:'Asia/Bangkok',     lat:21.030, lng:105.850,bbox:[20.98,105.79,21.07,105.90] },
  { slug:'ho-chi-minh', name:'Ho Chi Minh City',country:'VN',region:'Asia',  tz:'Asia/Bangkok',     lat:10.776, lng:106.700,bbox:[10.72,106.63,10.83,106.75] },
  { slug:'da-nang',     name:'Da Nang',       country:'VN', region:'Asia',   tz:'Asia/Bangkok',     lat:16.055, lng:108.220,bbox:[15.99,108.15,16.10,108.30] },
  { slug:'siem-reap',   name:'Siem Reap',     country:'KH', region:'Asia',   tz:'Asia/Bangkok',     lat:13.362, lng:103.860,bbox:[13.30,103.79,13.42,103.92] },
  { slug:'manila',      name:'Manila',        country:'PH', region:'Asia',   tz:'Asia/Manila',      lat:14.599, lng:120.984,bbox:[14.50,120.93,14.68,121.08] },
  { slug:'dubai',       name:'Dubai',         country:'AE', region:'Asia',   tz:'Asia/Dubai',       lat:25.204, lng:55.271, bbox:[25.05,55.10,25.31,55.40] },
  { slug:'colombo',     name:'Colombo',       country:'LK', region:'Asia',   tz:'Asia/Colombo',     lat:6.927,  lng:79.861, bbox:[6.85,79.82,7.00,79.92] },
  { slug:'goa',         name:'Goa',           country:'IN', region:'Asia',   tz:'Asia/Kolkata',     lat:15.540, lng:73.790, bbox:[15.42,73.70,15.66,73.90] },

  // ─── Islands & beach ────────────────────────────────────────────
  { slug:'bali',        name:'Bali',          country:'ID', region:'Islands',tz:'Asia/Makassar',    lat:-8.560, lng:115.190,bbox:[-8.78,115.08,-8.38,115.34] },
  { slug:'phi-phi',     name:'Koh Phi Phi',   country:'TH', region:'Islands',tz:'Asia/Bangkok',     lat:7.740,  lng:98.778, bbox:[7.68,98.73,7.82,98.83] },
  { slug:'langkawi',    name:'Langkawi',      country:'MY', region:'Islands',tz:'Asia/Kuala_Lumpur',lat:6.350,  lng:99.800, bbox:[6.20,99.62,6.46,99.90] },
  { slug:'boracay',     name:'Boracay',       country:'PH', region:'Islands',tz:'Asia/Manila',      lat:11.967, lng:121.925,bbox:[11.90,121.88,12.02,121.97] },
  { slug:'maldives',    name:'Maldives (Malé)',country:'MV',region:'Islands',tz:'Indian/Maldives',  lat:4.175,  lng:73.509, bbox:[4.10,73.40,4.30,73.60] },
  { slug:'mauritius',   name:'Mauritius',     country:'MU', region:'Islands',tz:'Indian/Mauritius', lat:-20.164,lng:57.501, bbox:[-20.30,57.35,-19.98,57.68] },
  { slug:'santorini',   name:'Santorini',     country:'GR', region:'Islands',tz:'Europe/Athens',    lat:36.393, lng:25.461, bbox:[36.32,25.34,36.48,25.52] },
  { slug:'mykonos',     name:'Mykonos',       country:'GR', region:'Islands',tz:'Europe/Athens',    lat:37.445, lng:25.328, bbox:[37.40,25.26,37.50,25.42] },
  { slug:'ibiza',       name:'Ibiza',         country:'ES', region:'Islands',tz:'Europe/Madrid',    lat:38.909, lng:1.432,  bbox:[38.82,1.28,39.00,1.58] },
  { slug:'mallorca',    name:'Mallorca',      country:'ES', region:'Islands',tz:'Europe/Madrid',    lat:39.570, lng:2.650,  bbox:[39.48,2.55,39.65,2.79] },
  { slug:'cancun',      name:'Cancún',        country:'MX', region:'Islands',tz:'America/Cancun',   lat:21.161, lng:-86.851,bbox:[21.03,-86.92,21.23,-86.74] },
  { slug:'tulum',       name:'Tulum',         country:'MX', region:'Islands',tz:'America/Cancun',   lat:20.212, lng:-87.466,bbox:[20.15,-87.52,20.28,-87.40] },
  { slug:'honolulu',    name:'Honolulu',      country:'US', region:'Islands',tz:'Pacific/Honolulu', lat:21.307, lng:-157.858,bbox:[21.24,-157.90,21.36,-157.76] },
  { slug:'nassau',      name:'Nassau',        country:'BS', region:'Islands',tz:'America/Nassau',   lat:25.060, lng:-77.345,bbox:[25.00,-77.45,25.12,-77.25] },
  { slug:'bridgetown',  name:'Barbados',      country:'BB', region:'Islands',tz:'America/Barbados', lat:13.098, lng:-59.617,bbox:[13.03,-59.68,13.20,-59.53] },

  // ─── UAE (dubai already live above) ─────────────────────────────
  { slug:'abu-dhabi',   name:'Abu Dhabi',     country:'AE', region:'Asia',   tz:'Asia/Dubai',       lat:24.453, lng:54.377, bbox:[24.28,54.28,24.55,54.65] },
  { slug:'sharjah',     name:'Sharjah',       country:'AE', region:'Asia',   tz:'Asia/Dubai',       lat:25.346, lng:55.421, bbox:[25.27,55.35,25.42,55.52] },
  { slug:'ajman',       name:'Ajman',         country:'AE', region:'Asia',   tz:'Asia/Dubai',       lat:25.405, lng:55.513, bbox:[25.36,55.43,25.46,55.56] },
  { slug:'ras-al-khaimah', name:'Ras Al Khaimah', country:'AE', region:'Asia', tz:'Asia/Dubai',    lat:25.800, lng:55.976, bbox:[25.65,55.85,25.90,56.10] },
  { slug:'fujairah',    name:'Fujairah',      country:'AE', region:'Asia',   tz:'Asia/Dubai',       lat:25.123, lng:56.337, bbox:[25.05,56.24,25.22,56.38] },
  { slug:'al-ain',      name:'Al Ain',        country:'AE', region:'Asia',   tz:'Asia/Dubai',       lat:24.208, lng:55.745, bbox:[24.10,55.60,24.30,55.85] },

  // ─── US metros ──────────────────────────────────────────────────
  { slug:'los-angeles', name:'Los Angeles',   country:'US', region:'Americas', tz:'America/Los_Angeles', lat:34.052, lng:-118.244, bbox:[33.92,-118.52,34.17,-118.13] },
  { slug:'orange-county', name:'Orange County', country:'US', region:'Americas', tz:'America/Los_Angeles', lat:33.717, lng:-117.831, bbox:[33.53,-118.05,33.92,-117.65] },
  { slug:'miami',       name:'Miami',         country:'US', region:'Americas', tz:'America/New_York', lat:25.762, lng:-80.192, bbox:[25.69,-80.32,25.87,-80.11] },
  { slug:'new-york',    name:'New York',      country:'US', region:'Americas', tz:'America/New_York', lat:40.713, lng:-74.006, bbox:[40.66,-74.03,40.88,-73.90] },
];

export const bySlug = Object.fromEntries(DESTINATIONS.map(d => [d.slug, d]));
