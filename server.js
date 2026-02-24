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

// Serve index.html and other static files from this folder
app.use(express.static(path.resolve('./')));

// Helper: wait for ms
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// POST /upload: the frontend sends the recorded WebM file here
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;

    // 1) Upload the audio file to AssemblyAI's upload endpoint
    const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        'authorization': AAI_KEY,
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

    // 2) Create transcript with strong summarisation
    const createResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        'authorization': AAI_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: fileUrl,
        speech_models: ["universal-2"],
        summarization: true,
        summary_type: "paragraph",     // shorter paragraph summary
        summary_model: "informative",
        auto_highlights: true,
        iab_categories: true
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
          headers: { 'authorization': AAI_KEY }
        }
      );
      transcript = await pollResp.json();
    }

    if (transcript.status !== 'completed') {
      console.error('Transcription failed:', transcript.error);
      fs.unlink(filePath, () => {});
      return res.status(500).json({ error: 'Transcription failed: ' + transcript.error });
    }

    const fullText = transcript.text || '';
    const summaryText = Array.isArray(transcript.summary)
      ? transcript.summary.join('\n')
      : (transcript.summary || '');

    // 4) Clean up local temp file
    fs.unlink(filePath, () => {});

    // 5) Send response back to frontend
    res.json({
      transcript: fullText,
      summary: summaryText
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`EchoNote server running at http://localhost:${PORT}`);
});
