// hyufa-service/backend/server.js
// HYUFA 금융 챗봇 백엔드
// - FAQ JSON 로드
// - FAQ 상위 매칭 3개를 OpenAI에 컨텍스트로 전달
// - /chat 엔드포인트로 프론트와 통신

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import fetch from 'node-fetch'

// -------------------------------
// 1. 환경설정 및 경로 세팅
// -------------------------------

// key.env 파일에서 OPENAI_API_KEY 읽기
// key.env 예시:
// OPENAI_API_KEY=sk-xxxx
dotenv.config({ path: path.resolve(process.cwd(), 'key.env') })

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
if (!OPENAI_API_KEY) {
  console.warn(
    '[WARN] OPENAI_API_KEY가 설정되지 않았습니다. key.env 파일을 확인하세요.'
  )
}

// __dirname 흉내 (ESM 환경)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// FAQ JSON 파일 경로 (backend 기준 ../frontend/)
const FAQ_PATH = path.resolve(
  __dirname,
  '../frontend/finance_chatbot_knowledge_104qa.json'
)

// -------------------------------
// 2. FAQ 데이터 로드
// -------------------------------

let faqData = []
try {
  const raw = fs.readFileSync(FAQ_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  faqData = Array.isArray(parsed) ? parsed : []
  console.log(
    `✅ Loaded ${faqData.length} FAQ items from ${FAQ_PATH.replace(
      process.cwd(),
      '.'
    )}`
  )
} catch (err) {
  console.error('❌ FAQ JSON 로드 실패:', err.message)
  faqData = []
}

// -------------------------------
// 3. FAQ 매칭 유틸 함수들
// -------------------------------

function normalize(text = '') {
  return text
    .toLowerCase()
    .replace(/[^0-9a-zA-Z가-힣\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(text = '') {
  return normalize(text).split(' ').filter(Boolean)
}

function overlapScore(a = '', b = '') {
  const aTokens = new Set(tokenize(a))
  const bTokens = new Set(tokenize(b))
  if (aTokens.size === 0 || bTokens.size === 0) return 0
  let score = 0
  aTokens.forEach((t) => {
    if (bTokens.has(t)) score += 1
  })
  return score
}

// 질문과 가장 비슷한 FAQ 상위 k개 반환
function getTopFaqs(query, k = 3) {
  if (!faqData || faqData.length === 0) return []

  const scored = faqData.map((item) => {
    const q = item.question || ''
    const a = item.answer || ''
    const s1 = overlapScore(query, q)
    const s2 = overlapScore(query, q + ' ' + a)
    const score = Math.max(s1, s2)
    return { ...item, score }
  })

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

// -------------------------------
// 4. Express 앱 설정
// -------------------------------

const app = express()
app.use(cors()) // 개발 단계에서는 전체 허용
app.use(express.json())

// 건강 체크용
app.get('/health', (_req, res) => {
  res.json({ ok: true, message: 'HYUFA backend healthy' })
})

// FAQ JSON 내려주는 엔드포인트
// 프론트에서 contentFetchId=uploaded:finance_chatbot_knowledge_104qa.json 로 요청
app.get('/api/files/download', (req, res) => {
  const { contentFetchId } = req.query
  if (
    contentFetchId !== 'uploaded:finance_chatbot_knowledge_104qa.json' ||
    !faqData
  ) {
    return res.status(404).json({ error: 'FAQ file not found' })
  }
  return res.json(faqData)
})

// -------------------------------
// 5. /chat 엔드포인트 (FAQ + OpenAI)
// -------------------------------

app.post('/chat', async (req, res) => {
  try {
    const { history = [], prompt = '' } = req.body || {}

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' })
    }

    // 1) FAQ 상위 3개 찾기
    const topFaqs = getTopFaqs(prompt, 3)
    const faqContext =
      topFaqs.length > 0
        ? topFaqs
            .map(
              (f, idx) => `[FAQ ${idx + 1}]\nQ: ${f.question}\nA: ${f.answer}`
            )
            .join('\n\n')
        : '관련 FAQ를 찾지 못했습니다.'

    // 2) 대화 히스토리 정규화 (role/user/assistant 섞여 들어와도 처리)
    const mappedHistory = Array.isArray(history)
      ? history
          .filter((m) => m && (m.text || m.content))
          .map((m) => {
            const role =
              m.role ||
              (m.sender === 'user'
                ? 'user'
                : m.sender === 'assistant' || m.sender === 'ai'
                ? 'assistant'
                : 'user')
            const content = m.text || m.content || ''
            return { role, content }
          })
      : []

    // 3) OpenAI 메시지 구성
    const messages = [
      {
        role: 'system',
        content:
          '당신은 한국의 대학생·사회초년생을 위한 재무설계사이자 상담가입니다.\n' +
          '반드시 다음 원칙을 지키세요:\n' +
          '1) FAQ 내용을 최우선으로 참고하되, 그대로 복사하지 말고 질문에 맞게 재구성해서 설명할 것.\n' +
          "2) 단순 이론 나열이 아니라, 질문자가 실제로 지금 무엇을 하면 좋을지 '실행 계획' 형태로 제시할 것.\n" +
          '3) 가능하면 금액, 기간, 비율 등을 구체적인 숫자 예시로 들어줄 것. (예: 월 30만원, 3년 등)\n' +
          '4) 대학생/사회초년생 입장에서 현실성 없는 투자·대출은 피하고, 안전한 방향으로 조언할 것.\n' +
          '5) 답변 구조는 다음과 같이 작성할 것:\n' +
          '   - [상황 요약]\n' +
          '   - [핵심 결론 3줄 이내]\n' +
          '   - [단계별 실행 계획]\n' +
          '   - [FAQ에서 참고한 내용 정리] (있다면)\n\n' +
          '아래는 HYUFA FAQ에서 가져온 참고 정보입니다. 질문과 직접 관련된 내용 위주로 활용하세요.\n\n' +
          '=== HYUFA FAQ 참고 정보 ===\n' +
          faqContext,
      },
      ...mappedHistory,
      {
        role: 'user',
        content: prompt,
      },
    ]

    // 4) OpenAI Chat Completions 호출
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o', // 필요하면 gpt-4o로 변경 가능
        messages,
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('❌ OpenAI API error:', errText)
      return res.status(500).json({ error: 'OpenAI API error' })
    }

    const data = await response.json()
    const replyText =
      data?.choices?.[0]?.message?.content ||
      '답변을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.'

    return res.json({
      reply: replyText,
      faqMatches: topFaqs.map((f) => ({
        question: f.question,
        answer: f.answer,
        score: f.score,
      })),
    })
  } catch (err) {
    console.error('❌ /chat 처리 중 서버 오류:', err)
    return res.status(500).json({ error: 'Server error while handling /chat' })
  }
})

// -------------------------------
// 6. 서버 실행
// -------------------------------

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 HYUFA backend server is running on port ${PORT}`)
})
