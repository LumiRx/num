/* NUM — shared site JS */
(function(){
  /* Live API. Was '' — which silently disabled every fetch and lost all submissions.
     Override per-page with window.NUM_API_BASE, or ?api= for testing. */
  var API = new URLSearchParams(location.search).get('api') || window.NUM_API_BASE
            || 'https://itsnum.com';
  var STORE = 'num_store';
  function loadStore(){ try{ return JSON.parse(localStorage.getItem(STORE) || '{"listings":[]}'); }catch(e){ return {listings:[]}; } }
  function saveStore(s){ try{ localStorage.setItem(STORE, JSON.stringify(s)); }catch(e){} }

  window.NUM = {
    api: API,
    demo: !API,
    loadStore: loadStore,
    saveStore: saveStore,
    upsert: function(rec){
      var s = loadStore(); s.listings = s.listings || [];
      var i = s.listings.findIndex(function(x){ return x.vendor_id === rec.vendor_id; });
      if(i >= 0){ s.listings[i] = Object.assign(s.listings[i], rec); } else { s.listings.push(rec); }
      s.current = rec.vendor_id; saveStore(s);
    },
    call: async function(path, method, body){
      if(!API) return null;
      try{
        var r = await fetch(API.replace(/\/$/, '') + path, {
          method: method || 'GET',
          headers: {'Content-Type':'application/json'},
          body: body ? JSON.stringify(body) : undefined
        });
        var j = await r.json();
        if(!r.ok || j.ok === false){ return {__error: (j && j.error) || ('HTTP ' + r.status)}; }
        return j;
      }catch(e){ return {__error: 'network'}; }
    },
    /* Canonical lead capture. Every NUM signup surface funnels here so nothing is lost. */
    claim: async function(fields){
      return await window.NUM.call('/api/claim', 'POST', fields);
    },

    /* ── auth ──────────────────────────────────────────────────────────
       Uses the EXISTING, already-live NUM account system on the Workers
       stack — /api/accounts/*. Do not build a second one here.

       The session is an HttpOnly `num_session` cookie scoped to Path=/ on
       itsnum.com, so:
         • JavaScript cannot read it (that's the point — it's XSS-proof)
         • it is sent automatically on same-origin requests
         • these pages work because they're served from itsnum.com too
       Every call therefore uses a RELATIVE url + credentials:'same-origin'.
       Never point these at an absolute worker URL — the cookie won't go. */
    acct: async function(path, body){
      try{
        var r = await fetch(path, {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'same-origin',
          headers: body === undefined ? undefined : { 'content-type':'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body || {})
        });
        var j = await r.json();
        if(!r.ok || j.error){ return {__error:(j && j.error) || ('HTTP ' + r.status)}; }
        return j;
      }catch(e){ return {__error:'network'}; }
    },

    /* Who am I? → {signed_in:false} or the account. Cookie is HttpOnly, so
       this request IS the only way to know — there is no local flag to read. */
    me: async function(){ return await window.NUM.acct('/api/accounts/me'); },
    signedIn: async function(){
      var m = await window.NUM.me();
      return !!(m && !m.__error && m.signed_in);
    },

    /* Email sign-in link. The server replies the same way whether or not the
       address has access, so this can't be used to discover who has accounts. */
    emailSignIn: async function(email){
      return await window.NUM.acct('/api/accounts/login', { email: email });
    },

    signOut: async function(){
      await window.NUM.acct('/api/accounts/logout', {});
      location.href = 'index.html';
    }
  };

  document.addEventListener('DOMContentLoaded', function(){
    /* Auth-aware nav. The session cookie is HttpOnly, so this has to ask the
       server — it can't be read locally. Async on purpose; the link simply
       stays "Sign in" until we hear back, which is the safe default. */
    (async function(){
      try{
        var authLink = document.getElementById('navAuth');
        if(!authLink) return;
        var m = await window.NUM.me();
        if(m && !m.__error && m.signed_in){
          authLink.textContent = 'Sign out';
          authLink.title = m.email ? ('Signed in as ' + m.email) : 'Signed in';
          authLink.href = '#';
          authLink.addEventListener('click', function(ev){ ev.preventDefault(); window.NUM.signOut(); });
        }
      }catch(e){}
    })();
    // mobile nav toggle
    var nav = document.querySelector('.nav'), btn = document.querySelector('.menu-btn');
    if(btn && nav){ btn.addEventListener('click', function(){ nav.classList.toggle('open'); }); }
    // active link
    var here = (location.pathname.split('/').pop() || 'index.html'); if(here === '') here = 'index.html';
    document.querySelectorAll('.navlinks a, .mobile a').forEach(function(a){
      var href = a.getAttribute('href') || '';
      if(href === here) a.classList.add('active');
    });
    // reveal on scroll
    if('IntersectionObserver' in window){
      var io = new IntersectionObserver(function(es){
        es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
      }, {threshold: .12});
      document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });
    } else {
      document.querySelectorAll('.reveal').forEach(function(el){ el.classList.add('in'); });
    }
  });
})();
