// netlify/functions/get-config.js
// 把 Supabase 公开配置从环境变量返回给前端
// anon key 本身是公开的，但不能硬编码在代码里（会触发 Netlify 扫描）
exports.handler = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
  },
  body: JSON.stringify({
    supabaseUrl : process.env.SUPABASE_URL,
    supabaseKey : process.env.SUPABASE_ANON_KEY,
  }),
});
