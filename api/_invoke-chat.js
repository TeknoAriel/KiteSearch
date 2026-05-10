/**
 * Invoca el handler de POST /api/chat sin HTTP (para webhooks u otros workers).
 */
module.exports = function invokeChatPost(body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const res = {
      setHeader() {},
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        if (settled) return;
        settled = true;
        resolve({ statusCode: this.statusCode || 200, data });
      },
      end() {
        if (settled) return;
        settled = true;
        resolve({ statusCode: this.statusCode || 200, data: null });
      }
    };
    const handler = require('./chat.js');
    Promise.resolve(handler({ method: 'POST', body }, res))
      .then(() => {
        if (!settled) {
          settled = true;
          resolve({ statusCode: res.statusCode || 500, data: null });
        }
      })
      .catch(reject);
  });
};
