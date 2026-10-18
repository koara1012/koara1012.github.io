import { DatabaseSync } from 'node:sqlite';
export function makeDB() {
  const db = new DatabaseSync(':memory:');
  class Stmt { constructor(s){this.sql=s;this.args=[];} bind(...a){this.args=a.map(v=>v===undefined?null:v);return this;}
    async first(){return db.prepare(this.sql).get(...this.args)??null;}
    async all(){return {results:db.prepare(this.sql).all(...this.args)};}
    async run(){const r=db.prepare(this.sql).run(...this.args);return {meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}};} }
  return { raw: db, prepare:(s)=>new Stmt(s), batch: async (ss)=>{const o=[];for(const s of ss)o.push(await s.run());return o;} };
}
// fake AI: remembers calls; answers by schema
export const calls = [];
export const control = { scoreFor: () => ({ interest: 50, eagerness: 50, bond: 50 }) };
export function installFetch(pushes) {
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('generativelanguage') || url.includes('api.x.ai')) {
      const body = JSON.parse(init.body);
      const grok = url.includes('x.ai');
      const sys = grok ? body.messages[0].content : body.systemInstruction.parts[0].text;
      const user = grok ? body.messages.slice(1).map(m=>m.content).join('\n') : body.contents.map(c=>c.parts[0].text).join('\n');
      const schemaStr = JSON.stringify(grok ? body.response_format : body.generationConfig.responseSchema);
      calls.push({ grok, sys, user, schemaStr });
      let out;
      if (schemaStr.includes('scores')) {
        const ids = [...user.matchAll(/## id: (\S+) ／/g)].map(m=>m[1]);
        out = { scores: ids.map(id => ({ id, note: id+'の気持ち', ...control.scoreFor(id, user) })) };
      } else if (schemaStr.includes('"text"')) {
        out = { text: (sys.includes('コメントを書きます') ? 'コメント' : '投稿') + '#' + calls.length };
      } else out = { messages: ['返事#' + calls.length] };
      const txt = JSON.stringify(out);
      return new Response(JSON.stringify(grok ? { choices: [{ message: { content: txt } }] } : { candidates: [{ content: { parts: [{ text: txt }] } }] }), { status: 200 });
    }
    if (url.startsWith('https://push.example.test')) { pushes.push(init); return new Response('', { status: 201 }); }
    throw new Error('unexpected fetch ' + url);
  };
}
