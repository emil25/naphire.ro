/* Vercel szerveroldali RSS-lekérő
   A honlap /rss?url=<feed-cím> formában hívja (a vercel.json átirányítja ide).
   Előnye: nem függ az ingyenes, korlátozott CORS-proxyktól. */

const ENGEDETT_HOSZTOK = [
  'maszol.ro', 'kronikaonline.ro', 'szekelyhon.ro', 'transtelex.ro',
  '3szek.ro', 'hargitanepe.ro', 'telex.hu', 'hvg.hu', '24.hu',
  'index.hu', '444.hu', 'origo.hu', 'youtube.com',
  'szekelykonyhaeskert.ro', 'noileg.ro'
];

export default async function handler(req, res) {
  const kert = req.query.url;
  if (!kert) return res.status(400).send('Hiányzó url paraméter');

  let cel;
  try { cel = new URL(kert); } catch (e) {
    return res.status(400).send('Érvénytelen URL');
  }
  if (!/^https?:$/.test(cel.protocol))
    return res.status(400).send('Csak http/https engedélyezett');

  // csak a honlapon használt hírforrásokat szolgáljuk ki, hogy ne váljon nyílt proxyvá
  const gazda = cel.hostname.replace(/^www\./, '');
  const engedett = ENGEDETT_HOSZTOK.some(h => gazda === h || gazda.endsWith('.' + h));
  if (!engedett) return res.status(403).send('Nem engedélyezett forrás');

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const valasz = await fetch(cel.toString(), {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NapHireRSS/1.0)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      }
    });
    clearTimeout(t);
    if (!valasz.ok) return res.status(502).send('A forrás nem elérhető');
    const szoveg = await valasz.text();
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Vercel él-gyorsítótár: 4 percig cache-eli, közben a háttérben frissíti – kíméli a forrásokat
    res.setHeader('Cache-Control', 's-maxage=240, stale-while-revalidate=600');
    return res.status(200).send(szoveg);
  } catch (e) {
    return res.status(502).send('Lekérési hiba');
  }
}
