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
const AAI_LLM_KEY = process.env.ASSEMBLYAI_LLM_API_KEY || AAI_KEY; // reuse key if same

// Serve index.html and other static files from this folder
app.use(express.static(path.resolve('./')));

// Parse JSON bodies for /summarize
app.use(express.json());

// Helper: wait for ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------
// 1) /upload – audio -> transcript only
// ---------------------------
//
// Frontend sends the recorded or uploaded file here.
// This route:
//   - uploads to AssemblyAI
//   - creates a transcript (NO summarization here)
//   - polls until completed
//   - returns { transcript: "full text..." }
//
app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;

    // 1) Upload the audio file to AssemblyAI's upload endpoint
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
      return res.status(500).json({ error: 'Upload failed' });
    }

    const uploadJson = await uploadResp.json();
    const fileUrl = uploadJson.upload_url; // proper https URL

    // 2) Create transcript WITHOUT summarization (we’ll summarize later)
    const createResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: AAI_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: fileUrl,
        speech_models: ['universal-2'],
        // summarization: false, // default
        auto_highlights: false,
        iab_categories: false,
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

    // 3) Poll until finished
    while (transcript.status === 'queued' || transcript.status === 'processing') {
      await sleep(3000);
      const pollResp = await fetch(
        `https://api.assemblyai.com/v2/transcript/${transcript.id}`,
        {
          headers: { authorization: AAI_KEY }
        }
      );
      transcript = await pollResp.json();
    }

    if (transcript.status !== 'completed') {
      console.error('Transcription failed:', transcript.error);
      fs.unlink(filePath, () => {});
      return res
        .status(500)
        .json({ error: 'Transcription failed: ' + transcript.error });
    }

    const fullText = transcript.text || '';

    // 4) Clean up local temp file
    fs.unlink(filePath, () => {});

    // 5) Send only transcript back to frontend
    res.json({
      transcript: fullText
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------
// 2) /summarize – transcript -> key points summary
// ---------------------------
//
// Frontend sends JSON:
//   { transcript: "full transcript text..." }
//
// We call AssemblyAI's LLM Gateway (or summarization)
// with a strong prompt to focus on key points only,
// then return { summary: "• bullet\n• bullet\n..." }
// ---------------------------
app.post('/summarize', async (req, res) => {
  try {
    const { transcript } = req.body || {};
    if (!transcript || typeof transcript !== 'string') {
      return res
        .status(400)
        .json({ error: 'Missing transcript text for summarization' });
    }

    // Build a prompt that forces key decisions, actions, and topics.
    const prompt = `
You are an expert meeting assistant.
Your task is to read the meeting transcript and extract ONLY important information.

Focus on:
- Key decisions made
- Action items (with who is responsible, if mentioned)
- Important topics discussed or conclusions reached

Ignore:
- Small talk
- Greetings and farewells
- Repetitive filler
- Off-topic chat

Write your answer as short bullet points (one sentence each).
Do not number them, just use a dash at the start of each line.

Meeting transcript:
${transcript}
    `.trim();

    // Call AssemblyAI LLM Gateway (chat completions style)[web:305][web:308][web:311]
    const llmResp = await fetch(
      'https://llm-gateway.assemblyai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          authorization: AAI_LLM_KEY,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ]
        })
      }
    );

    if (!llmResp.ok) {
      const t = await llmResp.text();
      console.error('LLM summary error:', llmResp.status, t);
      return res.status(500).json({ error: 'Summary generation failed' });
    }

    const result = await llmResp.json();
    let summaryText =
      result?.choices?.[0]?.message?.content?.[0]?.text ||
      result?.choices?.[0]?.message?.content ||
      '';

    if (!summaryText || typeof summaryText !== 'string') {
      summaryText = 'No summary could be generated from this transcript.';
    }

    // Respond with summary (front-end will render bullets)
    res.json({ summary: summaryText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during summarization' });
  }
});

app.listen(PORT, () => {
  console.log(`EchoNote server running at http://localhost:${PORT}`);
});
