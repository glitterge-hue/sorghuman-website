// netlify/functions/get-order.js
// 给司机配送页面提供订单信息（公开接口，用 stripe_session_id 查询）

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const crypto = require('crypto');
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type'                : 'application/json',
};

exports.handler = async (event) => {
  if(event.httpMethod==='OPTIONS') return { statusCode:200, headers:CORS, body:'' };

  const id = (event.queryStringParameters||{}).id;
  const expires = Number((event.queryStringParameters||{}).e);
  const sig = (event.queryStringParameters||{}).sig || '';
  if(!id || !expires || !sig) return { statusCode:401, headers:CORS, body: JSON.stringify({ error:'链接无效' }) };
  const expected = crypto.createHmac('sha256', process.env.DELIVERY_LINK_SECRET || process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${id}.${expires}`).digest();
  let supplied;
  try { supplied = Buffer.from(sig, 'base64url'); } catch { supplied = Buffer.alloc(0); }
  if (expires < Math.floor(Date.now()/1000) || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected))
    return { statusCode:401, headers:CORS, body: JSON.stringify({ error:'链接无效或已过期' }) };

  const headers = { 'apikey':SUPA_KEY, 'Authorization':`Bearer ${SUPA_KEY}` };

  const orders = await fetch(
    `${SUPA_URL}/rest/v1/orders?stripe_session_id=eq.${id}&select=id,status,shipping_address,customer_phone,store_id,total&limit=1`,
    { headers }
  ).then(r=>r.json());

  if(!orders.length)
    return { statusCode:404, headers:CORS, body: JSON.stringify({ error:'订单不存在' }) };

  const stores = await fetch(
    `${SUPA_URL}/rest/v1/stores?store_id=eq.${orders[0].store_id}&select=name_zh&limit=1`,
    { headers }
  ).then(r=>r.json());

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      order    : orders[0],
      storeName: stores[0]?.name_zh || '',
    })
  };
};
