// Backing services for the browser tests: an in-memory Postgres (PGlite over the
// Postgres wire protocol, so the app's normal `pg` driver connects to it) and a
// fake BGG XML API. Started by Playwright's webServer; runs until killed.
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export const DB_PORT = 54329;

export const BGG_PORT = 3199;

export const BGG_TOKEN = 'e2e-token';

const db = await PGlite.create();

await new PGLiteSocketServer({ db, host: '127.0.0.1', port: DB_PORT, maxConnections: 20 }).start();

const item = (id, name, subtype, rating, average) =>
    `<item objecttype="thing" objectid="${id}" subtype="${subtype}"><name sortindex="1">${name}</name>` +
    `<stats minplayers="1" maxplayers="4" playingtime="60"><rating value="${rating}"><average value="${average}"/></rating></stats></item>`;
const daysAgo = n => new Date(Date.now() - n * 864e5).toUTCString();
const listing = (condition, price, age, currency = 'USD') =>
    `<listing><listdate value="${daysAgo(age)}"/><price currency="${currency}" value="${price}"/><condition value="${condition}"/></listing>`;
const items = body => `<?xml version="1.0" encoding="utf-8"?><items>${body}</items>`;

const STANDALONE = items(
    item('900001', 'Fixture Quest', 'boardgame', '9', '8.1') + item('900002', 'Test Tiles', 'boardgame', 'N/A', '6.4')
);
const EXPANSIONS = items(item('900003', 'Fixture Quest: More Quests', 'boardgameexpansion', 'N/A', '8.0'));
const THINGS = items(`
 <item type="boardgame" id="900001"><minplayers value="1"/><maxplayers value="4"/><playingtime value="90"/>
  <poll-summary name="suggested_numplayers"><result name="bestwith" value="Best with 2–3 players"/></poll-summary>
  <link type="boardgamecategory" id="1" value="Fantasy"/><link type="boardgamemechanic" id="2" value="Cooperative Game"/>
  <statistics><ratings><averageweight value="3.2"/></ratings></statistics></item>
 <item type="boardgame" id="900002"><yearpublished value="2021"/><description>Lay tiles to build patterns.&amp;#10;&amp;#10;Score points for matching colours.</description><comments page="1" totalitems="1"><comment username="pat" rating="7" value="Quick to teach and surprisingly thinky for a filler game."/></comments><minplayers value="2"/><maxplayers value="4"/><playingtime value="30"/>
  <link type="boardgamecategory" id="3" value="Abstract Strategy"/><link type="boardgamepublisher" id="9" value="Tile Co."/>
  <marketplacelistings>${listing('good', '20.00', 30)}${listing('likenew', '25.00', 60)}${listing('verygood', '30.00', 90)}${listing('good', '99.00', 10, 'EUR')}${listing('new', '45.00', 20)}</marketplacelistings>
  <statistics><ratings><averageweight value="1.8"/></ratings></statistics></item>
 <item type="boardgameexpansion" id="900003"><minplayers value="1"/><maxplayers value="4"/><playingtime value="90"/>
  <link type="boardgameexpansion" id="900001" value="Fixture Quest" inbound="true"/>
  <statistics><ratings><averageweight value="3.3"/></ratings></statistics></item>`);

createServer((req, res) =>
{
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body = '') => res.writeHead(status, { 'content-type': 'text/xml' }).end(body);

    if (url.pathname === '/health')
    {
        return send(200, 'ok');
    }

    // Fake BoardGamePrices.com: store prices for Test Tiles.
    if (url.pathname === '/api/info')
    {
        const storeItems = url.searchParams
            .get('eid')
            .split(',')
            .filter(id => id === '900002')
            .map(id => ({
                external_id: id,
                url: `https://boardgameprices.com/item/show/${id}`,
                prices: [
                    { product: 40, shipping: '6.00', shipping_known: true, stock: 'Y' },
                    { product: 42, shipping: '6.00', shipping_known: true, stock: 'Y' },
                    { product: 44, shipping: '8.00', shipping_known: true, stock: 'Y' },
                    { product: 20, shipping: '5.00', shipping_known: true, stock: 'N' },
                ],
            }));

        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ currency: 'USD', items: storeItems }));
    }

    if (req.headers.authorization !== `Bearer ${BGG_TOKEN}`)
    {
        return send(401);
    }

    if (url.pathname === '/xmlapi2/collection')
    {
        if (url.searchParams.get('username') === 'nobody')
        {
            return send(200, '<errors><error><message>Invalid username specified</message></error></errors>');
        }

        return send(200, url.searchParams.get('subtype') === 'boardgameexpansion' ? EXPANSIONS : STANDALONE);
    }

    // Price lookups are slowed down a little so the progress bar can be observed.
    if (url.pathname === '/xmlapi2/thing' && url.searchParams.has('marketplace'))
    {
        return setTimeout(() => send(200, THINGS), 300);
    }

    if (url.pathname === '/xmlapi2/thing')
    {
        return send(200, THINGS);
    }

    send(404);
}).listen(BGG_PORT, '127.0.0.1', () => console.log(`e2e services ready (db :${DB_PORT}, bgg :${BGG_PORT})`));
