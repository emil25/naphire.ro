/* Vercel szerveroldali OKOS KERESÉS – /api/okoskereses?q=...
   Természetes nyelvű kérdést fogad ("Mi történt ma Romániában?"), a friss
   híranyagra támaszkodva a Claude API-val ad rá egy rövid, forrásokra
   hivatkozó választ. Nincs gyorsítótár rajta (minden kérdés más), ezért
   ez költségesebb hívásonként, mint az összefoglaló – a kliens oldalon
   figyelmeztetünk is rá, hogy ez nem fut automatikusan, csak kérésre. */

const FORRASOK = [
  { nev:'Maszol',       urls:['https://maszol.ro/rss'], region:'erdely' },
  { nev:'Krónika',      urls:['https://kronikaonline.ro/rss/kronika_hirek.xml'], region:'erdely' },
  { nev:'Székelyhon',   urls:['https://szekelyhon.ro/rss/szekelyhon_hirek.xml'], region:'erdely' },
  { nev:'Transtelex',   urls:['https://transtelex.ro/rss'], region:'erdely' },
  { nev:'Telex',        urls:['https://telex.hu/rss'], region:'magyar' },
  { nev:'HVG',          urls:['https://hvg.hu/rss'], region:'magyar' },
  { nev:'24.hu',        urls:['https://24.hu/feed/'], region:'magyar' },
  { nev:'Index',        urls:['https://index.hu/24ora/rss/'], region:'magyar' },
];

function tisztit(s){
  return (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g,'&')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
    .replace(/&#0?39;|&apos;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim();
}
function mezo(item, nev){
  const m = item.match(new RegExp('<' + nev + '[^>]*>([\\s\\S]*?)</' + nev + '>', 'i'));
  return m ? m[1] : '';
}
async function forrasLeker(forras){
  for (const url of forras.urls){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);
      const v = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent':'Mozilla/5.0 (compatible; NapHireAI/1.0)' }});
      clearTimeout(t);
      if (!v.ok) continue;
      const xml = await v.text();
      const elemek = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
      return elemek.slice(0, 10).map(item => ({
        cim: tisztit(mezo(item, 'title')),
        link: tisztit(mezo(item, 'link')),
        forras: forras.nev,
        region: forras.region
      })).filter(h => h.cim);
    }catch(e){ /* következő próba */ }
  }
  return [];
}

export default async function handler(req, res){
  const kerdes = (req.query.q || '').toString().trim().slice(0, 300);
  const kulcs = process.env.ANTHROPIC_API_KEY;

  if (!kerdes) return res.status(400).json({ hiba: 'hianyzo_kerdes' });
  if (!kulcs) return res.status(200).json({ hiba: 'nincs_api_kulcs', uzenet: 'Hiányzik az ANTHROPIC_API_KEY környezeti változó.' });

  try{
    const eredmenyek = await Promise.all(FORRASOK.map(f => forrasLeker(f)));
    const hirek = [].concat(...eredmenyek);
    if (!hirek.length) throw new Error('nincs hír');

    const lista = hirek.map((h, i) => `[${i}] (${h.region === 'erdely' ? 'Erdély' : 'Magyarország'} / ${h.forras}) ${h.cim}`).join('\n');
    const prompt = `Az alábbi mai hírcímek listája alapján válaszolj erre a kérdésre magyarul, ` +
      `röviden (max 4-5 mondat): "${kerdes}"\n\n` +
      `Csak a listában szereplő címek alapján válaszolj, ne találj ki tényeket. Ha a listában nincs ` +
      `releváns hír a kérdésre, mondd ezt meg őszintén. A válaszod VÉGÉRE írd oda szögletes zárójelben ` +
      `azoknak a hírsorszámoknak a listáját, amelyekre a válaszod épül, pl. [2,5,7].\n\nHírek:\n${lista}`;

    const valasz = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key': kulcs, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens: 500, messages:[{ role:'user', content: prompt }] })
    });
    if (!valasz.ok) throw new Error('AI API hiba: ' + valasz.status);
    const adat = await valasz.json();
    let szoveg = (adat.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    // a végén lévő [2,5,7] jellegű hivatkozást kiemeljük, és a valódi cikkekre mutató linkekké alakítjuk
    let forrasok = [];
    const m = szoveg.match(/\[([\d,\s]+)\]\s*$/);
    if (m){
      szoveg = szoveg.slice(0, m.index).trim();
      forrasok = m[1].split(',').map(s => parseInt(s.trim(), 10))
        .filter(i => Number.isInteger(i) && hirek[i]).map(i => hirek[i]);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ valasz: szoveg, forrasok });

  }catch(e){
    return res.status(200).json({ hiba: 'atmeneti', uzenet: String(e.message || e) });
  }
}
