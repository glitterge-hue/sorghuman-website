// netlify/functions/get-order.js
// 给司机配送页面提供订单信息（公开接口，用 stripe_session_id 查询）

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type'                : 'application/json',
};

exports.handler = async (event) => {
  if(event.httpMethod==='OPTIONS') return { statusCode:200, headers:CORS, body:'' };

  const id = (event.queryStringParameters||{}).id;
  if(!id) return { statusCode:400, headers:CORS, body: JSON.stringify({ error:'缺少 id' }) };

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
