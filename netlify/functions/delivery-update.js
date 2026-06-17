// netlify/functions/delivery-update.js
// 司机点"已到店"或"已送达"时更新订单状态并通知顾客

const SUPA_URL    = process.env.SUPABASE_URL;
const SUPA_KEY    = process.env.SUPABASE_SERVICE_KEY;
const TWILIO_SID  = process.env.TWILIO_SID;
const TWILIO_TOKEN= process.env.TWILIO_TOKEN;
const TWILIO_FROM = process.env.TWILIO_PHONE;
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type'                : 'application/json',
};

async function sb(qs){
  const res = await fetch(`${SUPA_URL}/rest/v1/${qs}`, {
    headers:{ 'apikey':SUPA_KEY, 'Authorization':`Bearer ${SUPA_KEY}` }
  });
  return res.json();
}

async function sendSms(to, body){
  if(!TWILIO_SID||!TWILIO_TOKEN||!TWILIO_FROM) return;
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,{
    method:'POST',
    headers:{ 'Authorization':`Basic ${auth}`, 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From:TWILIO_FROM, To:to, Body:body })
  });
}

exports.handler = async (event) => {
  if(event.httpMethod==='OPTIONS') return { statusCode:200, headers:CORS, body:'' };

  const params  = event.queryStringParameters || {};
  const orderId = params.id;   // stripe_session_id
  const action  = params.a;    // 'pickup' 或 'delivered'

  if(!orderId || !action)
    return { statusCode:400, headers:CORS, body: JSON.stringify({ error:'缺少参数' }) };

  // 查订单
  const orders = await sb(`orders?stripe_session_id=eq.${orderId}&select=*&limit=1`);
  const order  = orders[0];
  if(!order) return { statusCode:404, headers:CORS, body: JSON.stringify({ error:'订单不存在' }) };

  // 查门店名
  const stores = await sb(`stores?store_id=eq.${order.store_id}&select=name_zh,name_en&limit=1`);
  const storeName = stores[0]?.name_zh || order.store_id;

  const customerPhone = order.customer_phone;
  const shortId = (order.id||'').slice(-8).toUpperCase();

  if(action === 'pickup'){
    // 更新订单状态
    await fetch(`${SUPA_URL}/rest/v1/orders?stripe_session_id=eq.${orderId}`,{
      method:'PATCH',
      headers:{ 'apikey':SUPA_KEY,'Authorization':`Bearer ${SUPA_KEY}`,'Content-Type':'application/json' },
      body: JSON.stringify({ status:'delivering' })
    });
    // 通知顾客
    if(customerPhone){
      await sendSms(customerPhone,
        `【${storeName}】您的订单 #${shortId} 配送员已取货，正在前往您的地址。\n` +
        `如有疑问请联系门店。回复 STOP 退订。`
      );
    }
    return { statusCode:200, headers:CORS, body: JSON.stringify({ ok:true, msg:'pickup' }) };
  }

  if(action === 'delivered'){
    // 更新订单状态
    await fetch(`${SUPA_URL}/rest/v1/orders?stripe_session_id=eq.${orderId}`,{
      method:'PATCH',
      headers:{ 'apikey':SUPA_KEY,'Authorization':`Bearer ${SUPA_KEY}`,'Content-Type':'application/json' },
      body: JSON.stringify({ status:'delivered' })
    });
    // 通知顾客
    if(customerPhone){
      await sendSms(customerPhone,
        `【${storeName}】您的订单 #${shortId} 已送达！\n` +
        `感谢您的购买，期待再次为您服务 🙏\n回复 STOP 退订。`
      );
    }
    return { statusCode:200, headers:CORS, body: JSON.stringify({ ok:true, msg:'delivered' }) };
  }

  return { statusCode:400, headers:CORS, body: JSON.stringify({ error:'未知操作' }) };
};
