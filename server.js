import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const upload = multer({ dest: 'uploads/' });

const PORT = process.env.PORT || 3000;
const AAI_KEY = process.env.ASSEMBLYAI_API_KEY;

if (!AAI_KEY) {
  console.warn('Warning: ASSEMBLYAI_API_KEY is not set. /upload will fail.');
}

app.use(express.static(path.resolve('./')));
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!AAI_KEY) {
      fs.unlink(req.file.path, () => {});
      return res
        .status(500)
        .json({ error: 'Missing ASSEMBLYAI_API_KEY on server' });
    }

    const filePath = req.file.path;

    const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        authorization: AAI_KEY,
        'transfer-encoding': 'chunked'
      },
      body: fs.createReadStream(filePath)
    });

    if (!uploadResp.ok) {
      const t = await uploadResp.text();
      console.error('Upload error:', uploadResp.status, t);
      fs.unlink(filePath, () => {});
      return res.status(500).json({ error: 'Upload to AssemblyAI failed' });
    }

    const uploadJson = await uploadResp.json();
    const fileUrl = uploadJson.upload_url;

    const createResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: AAI_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: fileUrl,
        speech_models: ['universal-2'],
        punctuate: true,
        format_text: true
      })
    });

    if (!createResp.ok) {
      const t = await createResp.text();
      console.error('Create transcript error:', createResp.status, t);
      fs.unlink(filePath, () => {});
      return res.status(500).json({ error: 'Create transcript failed' });
    }

    let transcript = await createResp.json();

    while (
      transcript.status === 'queued' ||
      transcript.status === 'processing'
    ) {
      await sleep(3000);
      const pollResp = await fetch(
        `https://api.assemblyai.com/v2/transcript/${transcript.id}`,
        {
          headers: { authorization: AAI_KEY }
        }
      );
      transcript = await pollResp.json();
    }

    fs.unlink(filePath, () => {});

    if (transcript.status !== 'completed') {
      console.error('Transcription failed:', transcript.error);
      return res
        .status(500)
        .json({ error: 'Transcription failed: ' + transcript.error });
    }

    const fullText = transcript.text || '';
    console.log('Transcript length chars:', fullText.length);
    console.log('Transcript preview:', fullText.slice(0, 300));

    res.json({ transcript: fullText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during upload/transcription' });
  }
});

// /summarize: no max cap, minimum 3 bullets, always include first sentence
app.post('/summarize', async (req, res) => {
  try {
    const { transcript } = req.body || {};
    if (!transcript || typeof transcript !== 'string') {
      return res
        .status(400)
        .json({ error: 'Missing transcript text for summarization' });
    }

    const sentences = transcript
      .split(/[.?!]\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!sentences.length) {
      return res.json({
        summary: 'No summary could be generated from this transcript.'
      });
    }

    const actionKeywords = [
      'will',
      'need to',
      'should',
      'must',
      'action',
      'deadline',
      'follow up',
      'task',
      'assign',
      'decided',
      'agreed',
      'plan to',
      'next step',
      'next steps'
    ];

    const topicKeywords = [
      'discuss',
      'talk about',
      'focus on',
      'objective',
      'goal',
      'timeline',
      'milestone',
      'issue',
      'problem',
      'solution'
    ];

    const scored = sentences.map((s, idx) => {
      const lower = s.toLowerCase();
      let score = 0;

      actionKeywords.forEach((k) => {
        if (lower.includes(k)) score += 3;
      });

      topicKeywords.forEach((k) => {
        if (lower.includes(k)) score += 2;
      });

      const len = s.split(/\s+/).length;
      if (len > 6 && len < 40) score += 1;

      if (idx === 0 || idx === sentences.length - 1) score += 1;

      return { s, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // keep all sentences with positive score
    let top = scored.filter((item) => item.score > 0);

    // if none got a positive score, fall back to all sentences
    if (!top.length) {
      top = scored.slice();
    }

    // enforce minimum 3 sentences when possible
    const minSentences = Math.min(3, sentences.length);
    if (top.length < minSentences) {
      const existing = new Set(top.map((item) => item.s));
      for (const s of sentences) {
        if (!existing.has(s)) {
          top.push({ s, score: 0 });
          if (top.length >= minSentences) break;
        }
      }
    }

    // always include the first sentence for context
    const firstSentence = sentences[0];
    if (!top.some((item) => item.s === firstSentence)) {
      top.unshift({ s: firstSentence, score: Infinity });
    }

    // dedupe and restore original transcript order
    top = top.filter(
      (item, index, self) =>
        index === self.findIndex((other) => other.s === item.s)
    );
    top.sort(
      (a, b) => sentences.indexOf(a.s) - sentences.indexOf(b.s)
    );

    const bullets = top.map((item) => `• ${item.s}`).join('\n');
    const header = 'Key decisions, actions, and topics:';
    const summaryText = `${header}\n\n${bullets}`;

    res.json({ summary: summaryText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during summarization' });
  }
});

app.listen(PORT, () => {
  console.log(`EchoNote server running at http://localhost:${PORT}`);
});
