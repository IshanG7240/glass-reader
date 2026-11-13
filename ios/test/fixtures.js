// Made-up conversations for ios/test/run.js, served under each site's real hostname
// with (abridged) copies of its real security headers.

'use strict';

const NONCE = 'test-nonce-123';

// A study session: long answers with headings, lists, code, a table and maths.
const QUESTIONS = [
  'Explain eigenvalues and eigenvectors intuitively.',
  'How do I compute them for a 2×2 matrix?',
  'Why does the characteristic polynomial work?',
  'What is diagonalisation good for?',
  'Show me power iteration in Python.',
  'How does this relate to PCA?',
  'What goes wrong with repeated eigenvalues?',
  'Summarise everything as a cheat sheet.',
];
const answer = (i) => `## ${['The picture', 'Step by step', 'Why it works', 'Uses', 'Code', 'PCA', 'Defective matrices', 'Cheat sheet'][i]}

A matrix $A$ acts on vectors by stretching, rotating and shearing them. An **eigenvector** is a direction the matrix only stretches: $A\\mathbf{v} = \\lambda \\mathbf{v}$, where the scale factor $\\lambda$ is its *eigenvalue*. Most directions get knocked off their line; eigenvectors stay on theirs, which is why they describe what the matrix "really does".

$$\\det(A - \\lambda I) = 0$$

1. Subtract $\\lambda$ from the diagonal.
2. Take the determinant and set it to zero.
3. Solve for each $\\lambda$, then solve $(A - \\lambda I)\\mathbf{v} = 0$.

| Matrix | Eigenvalues | Meaning |
| --- | --- | --- |
| Rotation by 90° | $\\pm i$ | no real direction survives |
| Projection | 0 and 1 | kept or flattened |
| Shear | 1 (repeated) | one direction only |

\`\`\`python
import numpy as np
def power_iteration(A, steps=100):
    v = np.random.rand(A.shape[0])
    for _ in range(steps):
        v = A @ v
        v /= np.linalg.norm(v)
    return v @ A @ v, v
\`\`\`

The long-run behaviour of repeated multiplication is dominated by the largest eigenvalue, because every other component shrinks relative to it on each step. That single idea explains power iteration, Markov chains settling into a steady state, and why PCA's first component captures the most variance.`;

const html = (title, body, extraHead = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${extraHead}
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#212121;color:#ececec}main{max-width:720px;margin:0 auto;padding:24px}
.u{background:#303030;border-radius:18px;padding:10px 16px;margin:24px 0 12px auto;width:fit-content;max-width:70%}</style></head><body>${body}</body></html>`;

// The page as you'd see it (the userscript reads ChatGPT and Claude from their APIs,
// Gemini from the page).
const transcript = (n) => `<div style="height:100vh;overflow-y:auto"><main>${QUESTIONS.slice(0, n).map((q, i) => `<div class="u">${q}</div><p>${answer(i).slice(0, 300)}…</p>`).join('')}</main></div>`;

// ---------- ChatGPT ----------
const CHATGPT_ID = '6731f0aa-1111-2222-3333-444455556666';
function chatgptConversation() {
  const mapping = { root: { message: null, parent: null } };
  let parent = 'root';
  QUESTIONS.forEach((q, i) => {
    const u = `u${i}`, a = `a${i}`;
    mapping[u] = { parent, message: { author: { role: 'user' }, content: { content_type: 'text', parts: [q] } } };
    mapping[a] = { parent: u, message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [answer(i)] } } };
    parent = a;
  });
  return { title: 'Eigenvalues, intuitively', current_node: parent, mapping };
}

// ---------- Claude ----------
const CLAUDE_ID = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const ORG = '11111111-2222-3333-4444-555555555555';
function claudeConversation() {
  const msgs = [];
  let parent = '00000000-0000-4000-8000-000000000000';
  QUESTIONS.forEach((q, i) => {
    const u = `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, a = `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`;
    msgs.push({ uuid: u, parent_message_uuid: parent, sender: 'human', index: i * 2, content: [{ type: 'text', text: q }] });
    // With web search, a sentence arrives in pieces, each with the sources it cites.
    const content = i === 0 ? [{ type: 'text', text: answer(i) + '\n\nEigenvalues were named by ' }, { type: 'text', text: 'David Hilbert in 1904', citations: [{ url: 'https://en.wikipedia.org/wiki/Eigenvalues_and_eigenvectors', title: 'Eigenvalues' }] }, { type: 'text', text: ', from the German *eigen*.' }]
      : [{ type: 'text', text: answer(i) }];
    msgs.push({ uuid: a, parent_message_uuid: u, sender: 'assistant', index: i * 2 + 1, content });
    parent = a;
  });
  return { name: 'Eigenvalues, intuitively', current_leaf_message_uuid: parent, chat_messages: msgs };
}

// ---------- Gemini: rendered on the page, older turns load as you scroll up ----------
const geminiTurn = (i) => `<user-query><div class="query-text">${QUESTIONS[i]}</div></user-query>
<model-response><message-content><div class="markdown"><h2>Answer ${i + 1}</h2>
<p>A matrix acts on vectors by stretching, rotating and shearing them. An <b>eigenvector</b> is a direction the matrix only stretches, scaled by its <i>eigenvalue</i>. Most directions get knocked off their line; eigenvectors stay on theirs, which is why they describe what the matrix really does. The long-run behaviour of repeated multiplication is dominated by the largest eigenvalue.</p>
<ul><li>Subtract λ from the diagonal.</li><li>Take the determinant and set it to zero.</li><li>Solve for each λ.</li></ul>
<pre><code class="language-python">v = A @ v
v /= np.linalg.norm(v)</code></pre></div></message-content></model-response>`;
const geminiPage = html('Eigenvalues - Gemini', `<div id="scroll" style="height:100vh;overflow-y:auto"><main id="chat"></main></div>
<script nonce="${NONCE}">
  const turns = ${JSON.stringify(QUESTIONS.map((_, i) => geminiTurn(i)))};
  let first = turns.length - 3;
  const chat = document.getElementById('chat'), sc = document.getElementById('scroll');
  const policy = trustedTypes.createPolicy('fixture', { createHTML: (s) => s });
  chat.innerHTML = policy.createHTML(turns.slice(first).join(''));
  while (sc.scrollHeight <= sc.clientHeight && first > 0) { first--; chat.innerHTML = policy.createHTML(turns.slice(first).join('')); }
  sc.scrollTop = sc.scrollHeight;
  let loading = false;
  sc.addEventListener('scroll', () => {
    if (sc.scrollTop > 40 || first === 0 || loading) return;
    loading = true;
    setTimeout(() => {
      const h = sc.scrollHeight;
      first = Math.max(0, first - 2);
      chat.innerHTML = policy.createHTML(turns.slice(first).join(''));
      sc.scrollTop = sc.scrollHeight - h;
      loading = false;
    }, 150);
  });
</script>`);


// ---------- ChatGPT with generated images between answers ----------
const CHATGPT_IMG_ID = '6731f0aa-aaaa-bbbb-cccc-ddddeeeeffff';
const PNG = Buffer.from('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', 'base64');
function chatgptImageConversation() {
  const mapping = { root: { message: null, parent: null } };
  let parent = 'root', n = 0;
  const add = (message) => { const id = 'm' + n++; mapping[id] = { parent, message }; parent = id; };
  QUESTIONS.slice(0, 4).forEach((q, i) => {
    // Pasted notes as a prompt: a Markdown heading first, bullets alone on their lines.
    if (i === 3) q = `#### ${q}\n\nFrom my notes:\n\n•\n\n**Diagonal form:** easy powers.\n\n•\n\n**Change of basis:** same map.\n\nExplain please.`;
    add({ author: { role: 'user' }, content: { content_type: 'text', parts: [q] } });
    if (i === 1 || i === 2) {
      // Image generation: the assistant calls the tool, the tool returns the picture.
      add({ author: { role: 'assistant' }, recipient: 't2uay3k.sj1i4kz', content: { content_type: 'code', text: '{"prompt":"a diagram"}' } });
      add({ author: { role: 'tool', name: 't2uay3k.sj1i4kz' }, content: { content_type: 'multimodal_text', parts: [
        { content_type: 'image_asset_pointer', asset_pointer: `sediment://file_00000000abc${i}`, width: 320, height: 200 } ] } });
    }
    // ChatGPT's newer UI markup inside an answer (self-closing tags a browser would leave open).
    const ui = i === 1 ? `\n\n<box border radius="lg" padding={3} gap={2}>\n  **Worked example**\n  <row align=center gap={3}>\n    <AsyncImage query="matrix" aspectRatio="1:1" maxWidth="64px"/>\n    <box flex="1" gap={1}>\n      **A shear**\n\n      <text color="secondary" size="sm">One repeated eigenvalue</text>\n      <badge color="success">Defective</badge>\n    </box>\n  </row>\n  <divider color="subtle"/>\n  Only one direction survives.\n</box>\n\n<AsyncImageGroup\n  queries={["eigenvector arrows diagram", "shear matrix grid"]}\n  layout="carousel" onSelect={(i) => i > 0}\n/>\n\n<WritingBlock id="1" variant="standard">A note to copy.\nSecond line.</WritingBlock>\n\n### After the components\n\nThis paragraph must stay a separate, formatted paragraph with **bold** text.` : '';
    // A study widget (a template ChatGPT runs as you click) and cited sources.
    const quiz = i === 2 ? `\n\nThe determinant is zero exactly when\ue200cite\ue202turn0search0\ue202turn0search2\ue201 the matrix squashes space.\ue200image_group\ue202{"query":["determinant area"]}\ue201\n\n<box border padding={3}>\n{@body const questions=[{q:"What is det of a rotation?",opts:["0","1","-1"],a:1,why:"Rotations keep area."},{q:"A singular matrix has det…",opts:["1","0"],a:1,why:"It flattens space."}]}\n{@body const [answers,setAnswers]=DIL.useState({})}\n{@body const [submitted,setSubmitted]=DIL.useState(false)}\n{#each questions as q,i}\n  **Q{i+1}. {q.q}**\n  <radio-group value={answers[i]} onChange={(v)=>setAnswers(p=>({...p,[i]:Number(v)}))}>\n    {#each q.opts as opt,j}<radio value={String(j)} label={opt}/>{/each}\n  </radio-group>\n  {#if submitted}{#if answers[i]===q.a}**Correct**{:else}**Incorrect — {q.opts[q.a]}**{/if}\n  {q.why}{/if}\n{/each}\n{#if submitted}**Score: {questions.filter((q,i)=>answers[i]===q.a).length}/2**{:else}<button onClick={()=>setSubmitted(true)}>Check</button>{/if}\n</box>\n\n**Remember:** det = area scale.` : '';
    const refs = i === 2 ? { content_references: [
      { matched_text: '\ue200cite\ue202turn0search0\ue202turn0search2\ue201', type: 'grouped_webpages', items: [{ title: 'Determinant', url: 'https://en.wikipedia.org/wiki/Determinant', attribution: 'Wikipedia' }] },
      { matched_text: '\ue200image_group\ue202{"query":["determinant area"]}\ue201', type: 'image_group', images: [{ title: 'Area', thumbnail_url: 'https://chatgpt.com/files/area.png' }] },
    ] } : {};
    add({ author: { role: 'assistant' }, content: { content_type: 'text', parts: [answer(i) + ui + quiz] }, metadata: refs });
  });
  return { title: 'Eigenvalues with pictures', current_node: parent, mapping };
}

// ---------- ChatGPT when its API won't answer: read from the page itself ----------
const CHATGPT_DOM_ID = '6731f0aa-0000-1111-2222-333344445555';
const gptDomTurn = (i) => `<article data-testid="conversation-turn-${i * 2 + 1}"><div data-message-author-role="user" data-message-id="u${i}">
<div class="relative max-w-[70%]"><div class="whitespace-pre-wrap">${QUESTIONS[i]}</div></div></div></article>
<article data-testid="conversation-turn-${i * 2 + 2}"><div data-message-author-role="assistant" data-message-id="a${i}"><div class="flex flex-col"><div class="markdown prose dark:prose-invert w-full break-words">
<h3>Part ${i + 1}</h3><p>A matrix acts on vectors by stretching, rotating and shearing them. An <strong>eigenvector</strong> is a direction the matrix only stretches.</p>
<p>Most directions get knocked off their line; eigenvectors stay on theirs.</p>
<ol><li><p>Subtract λ from the diagonal.</p></li><li><p>Take the determinant.</p></li></ol>
<pre class="overflow-visible!"><div class="contain-inline-size rounded-md"><div class="flex items-center">python</div><div class="sticky"><button>Copy code</button></div><div class="overflow-y-auto p-4"><code class="whitespace-pre! language-python"><span class="hljs-keyword">def</span> f(A):
    <span class="hljs-keyword">return</span> A @ A</code></div></div></pre>
<p>That idea explains power iteration.</p></div></div></div></article>`;


exports.sites = {
  'chatgpt.com': {
    headers: {
      'content-security-policy': `default-src 'self'; script-src 'nonce-${NONCE}' 'self' 'wasm-unsafe-eval'; img-src * blob: data:; style-src 'self' 'unsafe-inline' blob:; font-src 'self' data:; connect-src 'self' blob:; frame-src 'self'; worker-src 'self' blob:; base-uri 'none'`,
      'cross-origin-opener-policy': 'same-origin-allow-popups',
    },
    routes: [
      { match: new RegExp(`^/c/${CHATGPT_DOM_ID}`), body: html('Eigenvalues from the page | ChatGPT', `<div style="height:100vh;overflow-y:auto"><main>${QUESTIONS.slice(0, 5).map((_, i) => gptDomTurn(i)).join('')}</main></div>`) },
      // The page with pictures: it has drawn one of the answer's pictures, and looked one up.
      { match: new RegExp(`^/c/${CHATGPT_IMG_ID}`), body: html('Eigenvalues with pictures | ChatGPT', `${transcript(4)}
<div data-message-author-role="assistant" data-message-id="m5"><img src="/files/matrix.png" width="200" height="150" alt=""></div>
<script nonce="${NONCE}">fetch('/backend-api/search/images?q=' + encodeURIComponent('matrix') + '&n=3');</script>`) },
      { match: /^\/c\//, body: html('Eigenvalues, intuitively | ChatGPT', transcript(8)) },
      { match: /^\/api\/auth\/session$/, body: { accessToken: 'test-token' } },
      { match: new RegExp(`^/backend-api/conversation/${CHATGPT_DOM_ID}$`), body: { __status: 401 } },
      { match: new RegExp(`^/backend-api/conversation/${CHATGPT_IMG_ID}$`), body: chatgptImageConversation },
      { match: /^\/backend-api\/conversation\/[\w-]+\/textdocs$/, body: [] },
      { match: /^\/backend-api\/conversation\/[\w-]+$/, body: chatgptConversation },
      { match: /^\/backend-api\/files\/download\/file_\w+$/, body: (u) => ({ download_url: `/files/${u.pathname.split('/').pop()}.png` }) },
      { match: /^\/backend-api\/search\/images$/, body: (u) => ({ results: [{ title: u.searchParams.get('q'), thumbnail_url: `/files/found-${u.searchParams.get('q').replace(/\W+/g, '-')}.png` }] }) },
      { match: /^\/files\/.+\.png$/, body: PNG },
    ],
  },
  'claude.ai': {
    headers: {
      'content-security-policy': `default-src 'none'; script-src 'nonce-${NONCE}' 'unsafe-eval'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-src 'self' blob:; child-src 'self' blob:; worker-src blob:; base-uri 'self'`,
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    },
    routes: [
      { match: /^\/chat\//, body: html('Eigenvalues, intuitively - Claude', transcript(8)) },
      { match: /^\/api\/organizations$/, body: [{ uuid: ORG, capabilities: ['chat'] }] },
      { match: /^\/api\/organizations\/[\w-]+\/chat_conversations\/[\w-]+$/, body: claudeConversation },
    ],
  },
  'gemini.google.com': {
    headers: {
      // Gemini sends several policies; one of them requires Trusted Types.
      'content-security-policy': `script-src 'nonce-${NONCE}' 'unsafe-inline' 'unsafe-eval' 'strict-dynamic' https: http:; object-src 'self'; base-uri 'self', require-trusted-types-for 'script', default-src 'none'; script-src * 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'report-sample' 'unsafe-inline' https://www.gstatic.com; font-src data: https://fonts.gstatic.com; img-src * data: blob:; connect-src 'self'; child-src 'self'; frame-src 'self'`,
    },
    routes: [{ match: /^\/app\//, body: geminiPage }],
  },
};

exports.pages = {
  chatgpt: `https://chatgpt.com/c/${CHATGPT_ID}`,
  claude: `https://claude.ai/chat/${CLAUDE_ID}`,
  gemini: 'https://gemini.google.com/app/5f2e8a1c9b3d',
  'chatgpt-images': `https://chatgpt.com/c/${CHATGPT_IMG_ID}`,
  'chatgpt-page': `https://chatgpt.com/c/${CHATGPT_DOM_ID}`,
};
// Pictures the reader should show (at least).
exports.expectImages = { 'chatgpt-images': 6 };
exports.expectTurns = { chatgpt: QUESTIONS.length, claude: QUESTIONS.length, gemini: QUESTIONS.length, 'chatgpt-images': 4, 'chatgpt-page': 5 };
