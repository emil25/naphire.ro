/* Vercel szerveroldali AI NAPI ÖSSZEFOGLALÓ – /api/osszefoglalo
   Lekéri a friss híreket (ugyanazokból a forrásokból, mint az /api/hirek),
   és a Claude API-val rövid, magyar nyelvű napi összefoglalót generáltat
   belőlük. Az eredményt 30 percig gyorsítótárazza – így NEM minden
   látogató hívása fizet AI-forgalmat, csak óránként néhányszor.

   FONTOS: az ANTHROPIC_API_KEY-t a Vercel projekt beállításaiban, a
   Environment Variables alatt kell megadni (SOHA nem kerülhet bele a
   kliens oldali kódba) – lásd az UTMUTATO.txt-t. */

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
      return elemek.slice(0, 8).map(item => ({
        cim: tisztit(mezo(item, 'title')),
        forras: forras.nev,
        region: forras.region
      })).filter(h => h.cim);
    }catch(e){ /* következő próba */ }
  }
  return [];
}

let elozoOsszefoglalo = null; // memóriabeli tartalék, ha az AI-hívás időlegesen sikertelen

export default async function handler(req, res){
  const kulcs = process.env.ANTHROPIC_API_KEY;
  if (!kulcs){
    return res.status(200).json({
      hiba: 'nincs_api_kulcs',
      uzenet: 'Az AI napi összefoglaló nincs beállítva: hiányzik az ANTHROPIC_API_KEY környezeti változó a Vercel projekt beállításaiban.'
    });
  }

  try{
    const eredmenyek = await Promise.all(FORRASOK.map(f => forrasLeker(f)));
    const cimek = [].concat(...eredmenyek);
    if (!cimek.length) throw new Error('nincs cím');

    const lista = cimek.map(h => `- [${h.region === 'erdely' ? 'Erdély' : 'Magyarország'} / ${h.forras}] ${h.cim}`).join('\n');
    const prompt = `Az alábbi mai magyar és erdélyi hírcímek alapján írj egy rövid, 4-6 mondatos, ` +
      `magyar nyelvű "Napi AI-összefoglalót" a legfontosabb történésekről. Ne sorold fel az összes hírt, ` +
      `csak a valóban jelentőset emeld ki, összefüggően, újságírói stílusban, semleges hangnemben. ` +
      `Ha van közös szál (pl. ugyanarról a témáról több cím is szól), azt emeld ki elsőként.\n\nCímek:\n${lista}`;

    const valasz = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key': kulcs,
        'anthropic-version':'2023-06-01'
      },
      body: JSON.stringify({
        model:'claude-sonnet-4-6',
        max_tokens: 400,
        messages:[{ role:'user', content: prompt }]
      })
    });

    if (!valasz.ok){
      const hibaszoveg = await valasz.text();
      throw new Error('AI API hiba: ' + valasz.status + ' ' + hibaszoveg.slice(0, 200));
    }
    const adat = await valasz.json();
    const szoveg = (adat.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!szoveg) throw new Error('üres AI-válasz');

    elozoOsszefoglalo = { szoveg, ido: new Date().toISOString() };
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600'); // 30 perc gyorsítótár
    return res.status(200).json({ szoveg, ido: elozoOsszefoglalo.ido, forrasDb: cimek.length });

  }catch(e){
    // ha időlegesen nem sikerül, az utolsó jó eredményt adjuk vissza, hogy ne törjön el a felület
    if (elozoOsszefoglalo){
      return res.status(200).json({ ...elozoOsszefoglalo, tartalek: true });
    }
    return res.status(200).json({ hiba: 'atmeneti', uzenet: String(e.message || e) });
  }
}
