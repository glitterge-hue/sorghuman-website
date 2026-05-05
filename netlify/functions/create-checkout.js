const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { lineItems, orderSummary } = JSON.parse(event.body);
    const origin = event.headers.origin || event.headers.referer || 'https://sorghuman.com';
    const baseUrl = origin.endsWith('/') ? origin.slice(0, -1) : origin;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      success_url: baseUrl + '/local-success.html',
      cancel_url: baseUrl + '/local.html',
      shipping_address_collection: { allowed_countries: ['US'] },
      locale: 'en',
      // 把购物车明细存入 metadata，供 webhook 建 Odoo 订单用
      metadata: {
        order: orderSummary || '',
      },
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.log('Stripe error:', err.message);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
