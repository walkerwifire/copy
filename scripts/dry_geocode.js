#!/usr/bin/env node
require('dotenv').config();
(async function(){
  const fetch = global.fetch || (await import('node-fetch')).default;
  const GEO_BBOX = process.env.GEO_BBOX || '-74.5,40.2,-72.5,41.2';
  const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
  const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';
  const OPENCAGE_KEY = process.env.OPENCAGE_KEY || '';

  // Usage: node dry_geocode.js [provider] [address]
  // Example: node dry_geocode.js google "150 Malcolm X Blvd, Brooklyn, NY 11221"
  const rawArgs = process.argv.slice(2);
  let providerOverride = null;
  let addrArg = '';
  if (rawArgs.length > 0) {
    // If first arg matches a provider name, use as override
    const p0 = rawArgs[0].toLowerCase();
    if (['google','mapbox','opencage','nominatim','all'].includes(p0)) {
      providerOverride = p0 === 'all' ? null : p0;
      addrArg = rawArgs.slice(1).join(' ');
    } else {
      addrArg = rawArgs.join(' ');
    }
  }
  const address = String(addrArg || '150 Malcolm X Blvd, Brooklyn, NY 11221').trim();

  function normalizeAddress(s){
    if(!s) return '';
    let norm = String(s).replace(/\s+/g,' ').trim();
    norm = norm.replace(/\b(apt|apartment|unit|fl|floor|ste|suite|bldg|building|#)\b\s*[:#\-]?\s*[\w\-\/]+/ig,'');
    norm = norm.replace(/[,\-]\s*(apt|apartment|unit|fl|floor|ste|suite|bldg|building)\b[\s\S]*$/ig,'');
    const zipMatch = norm.match(/(\b\d{5}(?:-\d{4})?\b)/);
    const zip = zipMatch ? zipMatch[1] : '';
    let stripped = norm.replace(/\b\d{5}(?:-\d{4})?\b/,'').trim();
    const houseMatch = stripped.match(/^\s*(\d{1,6})\b\s*(.*)$/);
    let parts = [];
    if(houseMatch){ parts.push(houseMatch[1]); parts.push((houseMatch[2]||'').split(',')[0].trim()); }
    else parts.push(stripped.split(',')[0].trim());
    if(zip) parts.push(zip);
    return parts.filter(Boolean).join(' ');
  }

  const addrNorm = normalizeAddress(address);
  console.log('Dry-run geocode for:', address);
  console.log('Normalized:', addrNorm);

  const candidates = [];
  const providerPriority = { google: 4, mapbox: 3, opencage: 2, nominatim: 1 };

  async function fetchRaw(url, opts) {
    try {
      const r = await fetch(url, opts);
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch(e) {}
      return { ok: r.ok, status: r.status, statusText: r.statusText, text, json };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  // Google
  try{
    if(GOOGLE_KEY){
      let zip = '';
      const m = addrNorm.match(/(\b\d{5}(?:-\d{4})?\b)$/);
      if(m) zip = m[1];
      const params = new URLSearchParams();
      params.set('address', addrNorm);
      params.set('key', GOOGLE_KEY);
      let comps = 'country:US'; if(zip) comps += `|postal_code:${zip}`;
      params.set('components', comps);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
      const resp = await fetchRaw(url);
      console.log('Google raw status:', resp.status, resp.statusText);
      if (!resp.ok) console.log('Google raw body:', resp.text);
      const j = resp.json || null;
      const results = Array.isArray(j && j.results)? j.results : [];
      for(const res of results){
        if(!res || !res.geometry) continue;
        const loc = res.geometry.location;
        const lt = (res.geometry.location_type||'').toUpperCase();
        const types = Array.isArray(res.types)? res.types: [];
        const isRooftop = lt==='ROOFTOP' || types.includes('street_address');
        let baseConf = isRooftop?0.95:0.75;
        try{
          const comps = Array.isArray(res.address_components)?res.address_components:[];
          const hasStreetNumber = comps.some(c=>Array.isArray(c.types)&&c.types.includes('street_number'));
          const hasRoute = comps.some(c=>Array.isArray(c.types)&&c.types.includes('route'));
          const postalComp = comps.find(c=>Array.isArray(c.types)&&c.types.includes('postal_code'));
          const compPost = postalComp?(postalComp.long_name||postalComp.short_name||'') : '';
          if(hasStreetNumber && hasRoute) baseConf += 0.05;
          if(compPost && zip && compPost===zip) baseConf += 0.03;
          const countryComp = comps.find(c=>Array.isArray(c.types)&&c.types.includes('country'));
          if(countryComp && countryComp.short_name && countryComp.short_name.toUpperCase()!=='US') baseConf = Math.min(baseConf,0.2);
        }catch(e){}
        try{ const formatted = (res.formatted_address||'').toLowerCase(); if(formatted.includes(addrNorm.toLowerCase().split(' ').slice(0,3).join(' '))) baseConf+=0.02; }catch(e){}
        candidates.push({ lat: Number(loc.lat), lng: Number(loc.lng), provider:'google', quality:isRooftop?'rooftop':(lt||'partial'), confidence: Math.min(1,baseConf) });
      }
    }
  }catch(e){ console.error('Google error', e.message||e); }

  // Mapbox
  try{
    if(MAPBOX_TOKEN){
      const q = encodeURIComponent(addrNorm);
      const params = new URLSearchParams(); params.set('access_token', MAPBOX_TOKEN); params.set('country','US'); params.set('types','address');
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json?${params.toString()}`;
      const resp = await fetchRaw(url);
      console.log('Mapbox raw status:', resp.status, resp.statusText);
      if (!resp.ok) console.log('Mapbox raw body:', resp.text);
      const j = resp.json || null; const f = Array.isArray(j && j.features)?j.features[0]:null;
      if(f && f.center){ const rel = Number(f.relevance||0); const isAddr = Array.isArray(f.place_type)&&f.place_type.includes('address'); let conf = rel; if(isAddr && rel>=0.9) conf = Math.max(conf,0.9); candidates.push({ lat:Number(f.center[1]), lng:Number(f.center[0]), provider:'mapbox', quality:isAddr?'address':(f.place_type&&f.place_type[0]||'unknown'), confidence: conf }); }
    }
  }catch(e){ console.error('Mapbox error', e.message||e); }

  // OpenCage
  try{
    if(OPENCAGE_KEY){
      const params = new URLSearchParams(); params.set('q', addrNorm); params.set('key', OPENCAGE_KEY); params.set('limit','1');
      const url = `https://api.opencagedata.com/geocode/v1/json?${params.toString()}`;
      const resp = await fetchRaw(url);
      console.log('OpenCage raw status:', resp.status, resp.statusText);
      if (!resp.ok) console.log('OpenCage raw body:', resp.text);
      const res = resp.json && Array.isArray(resp.json.results)?resp.json.results[0]:null;
      if(res && res.geometry){ const baseConf = Number(res.annotations?.confidence||0.7)||0.7; const isHouse = res.components&&(res.components._type==='house'||res.components._type==='building'); const conf = isHouse?Math.min(1,baseConf+0.1):baseConf; candidates.push({ lat:Number(res.geometry.lat), lng:Number(res.geometry.lng), provider:'opencage', quality: res.components && res.components._type||'unknown', confidence: conf }); }
    }
  }catch(e){ console.error('OpenCage error', e.message||e); }

  // Nominatim last resort (only if no candidates)
  try{
    if(candidates.length===0){
      const q = encodeURIComponent(addrNorm + ', US');
      const params = new URLSearchParams(); params.set('format','json'); params.set('addressdetails','0'); params.set('limit','1');
      const url = `https://nominatim.openstreetmap.org/search/${q}?${params.toString()}`;
      const resp = await fetchRaw(url, { headers: { 'User-Agent': 'technet-dashboard/1.0' } });
      console.log('Nominatim raw status:', resp.status, resp.statusText);
      if (!resp.ok) console.log('Nominatim raw body:', resp.text);
      const f = resp.json && Array.isArray(resp.json)?resp.json[0]:null;
      if(f && f.lat && f.lon){ const isHouse = (f.type||'').toLowerCase()==='house'||(f.type||'').toLowerCase()==='building'; const conf = isHouse?0.85:0.6; candidates.push({ lat:Number(f.lat), lng:Number(f.lon), provider:'nominatim', quality:f.type||'unknown', confidence: conf }); }
    }
  }catch(e){ console.error('Nominatim error', e.message||e); }

  // Adjust scores and apply bbox penalty
  const bboxParts = (String(GEO_BBOX||'').split(',').map(x=>parseFloat(x.trim()))).filter(x=>!isNaN(x));
  let minLng, minLat, maxLng, maxLat; if(bboxParts.length===4){ [minLng,minLat,maxLng,maxLat]=bboxParts; }
  // If provider override specified, filter candidates down to that provider only (for dry-run)
  if (providerOverride) {
    console.log('Provider override requested:', providerOverride);
  }

  for(const c of candidates){
    let precisionBoost = 0; const q = String(c.quality||'').toLowerCase(); if(q==='rooftop'||q==='street_address'||q==='address') precisionBoost+=0.12; if(q==='house'||q==='building') precisionBoost+=0.08; const pp = providerPriority[c.provider]||0;
    let outOfBounds = false; try{ if(typeof minLng==='number'){ const lat=Number(c.lat), lng=Number(c.lng); if(!(lng>=minLng && lng<=maxLng && lat>=minLat && lat<=maxLat)) outOfBounds=true; } }catch(e){}
    if(outOfBounds){ c.adjusted = (Number(c.confidence||0)*0.3)+(pp*0.001)-0.1; c.outOfBounds=true; } else { c.adjusted = (Number(c.confidence||0)+precisionBoost)+(pp*0.001); c.outOfBounds=false; }
  }
  // Apply provider override filter
  let filtered = candidates;
  if (providerOverride) {
    filtered = candidates.filter(c => c.provider === providerOverride);
  }

  filtered.sort((a,b)=>{ if((b.adjusted||0)!=(a.adjusted||0)) return (b.adjusted||0)-(a.adjusted||0); return (providerPriority[b.provider]||0)-(providerPriority[a.provider]||0); });

  console.log('\nCandidates (all):'); console.log(JSON.stringify(candidates, null, 2));
  console.log('\nCandidates (after override filter):'); console.log(JSON.stringify(filtered, null, 2));
  console.log('\nBest candidate (after filter):'); console.log(JSON.stringify(filtered[0]||null, null, 2));
  process.exit(0);
})();
