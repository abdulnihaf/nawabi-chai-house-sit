// NCH Cron Worker — triggers alert checks every 5 minutes
// Deploy separately: cd workers/nch-cron && wrangler deploy
// This Worker just calls the Pages API; all logic lives in wa-alerts.js

export default {
  async scheduled(event, env, ctx) {
    const url = 'https://nawabichaihouse.com/api/wa-alerts?action=cron-tick';
    ctx.waitUntil(
      fetch(url).then(r => r.json()).then(data => {
        if (!data.success) console.error('cron-tick failed:', data.error);
      }).catch(e => console.error('cron-tick error:', e.message))
    );
  }
};
