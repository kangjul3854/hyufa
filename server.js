import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',              // 나중에 github.io만 허용해도 됨
  methods: ['GET', 'POST', 'OPTIONS'],
}));

// 1) OpenAI 클라이언트
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,   // ★ Render 환경변수에서 가져옴
});

// 2) FAQ json 읽기
const knowledgePath = path.join(process.cwd(), 'backend', 'finance_chatbot_knowledge_104qa.json');
const faqData = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));

// 3) 간단한 health check (root URL 테스트용)
app.get('/', (req, res) => {
  res.send('HYUFA backend is running');
});

// 4) 실제 챗봇 엔드포인트
app.post('/chat', async (req, res) => {
  try {
    const { prompt, history, language = 'ko' } = req.body;

    // history는 필요하면 system·user·assistant 메시지로 가공
    const messages = [
      {
        role: 'system',
        content:
          (language === 'en'
            ? 'You are HYUFA, a financial assistant for university students and young professionals. Answer in English using the FAQ knowledge and be friendly and specific.'
            : '너는 대학생·사회초년생을 대상으로 금융 상담을 하는 HYUFA 챗봇이야. 아래 FAQ 데이터를 참고해서 최대한 친절하고 구체적으로 답해. ')
      },
      ...history || [],
      { role: 'user', content: prompt }
    ];

    // OpenAI 호출
    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages,
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });
  } catch (err) {
    console.error('❌ OpenAI API error:', err.response?.data || err.message);
    res.status(500).json({ error: 'OPENAI_ERROR' });
  }
});

// 5) Render 포트 사용
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 HYUFA backend running on port ${PORT}`);
});
