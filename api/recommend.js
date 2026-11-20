// ═══════════════════════════════════════════════════════════════
// LifeTrigger AI · 일정 기반 청년정책 추천 API (Vercel Serverless Function)
//   POST /api/recommend   { event, user, answers }
//   GET  /api/recommend   상태 확인 (환경변수 설정 여부)
//
// n8n 워크플로를 그대로 옮긴 구조
//   ① 일정 해석(규칙) → ① 일정 해석(AI) → 규칙+AI 합의
//   ② 후보 정책 선별(Supabase 3개 테이블 + 규칙) → AI 판단 5단계 → ③ 결과 정리
//
// 환경변수 (Vercel → Project → Settings → Environment Variables)
//   SUPABASE_URL               https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  Supabase service_role 키 (서버에서만 사용, 브라우저로 나가지 않음)
//   GEMINI_API_KEY             Google AI Studio API 키
//   GEMINI_MODEL               (선택) 기본값 gemini-2.5-flash
// ═══════════════════════════════════════════════════════════════

const GEMINI_MODEL_DEFAULT = 'gemini-2.5-flash';
const MAX_CANDIDATES = 25;
const CACHE_TTL_MS = 10 * 60 * 1000; // 정책 DB 캐시 10분 (같은 인스턴스가 살아 있는 동안)

const LABELS = {
  JOB_INTERVIEW: '💼 취업 면접', CERT_EXAM: '📝 자격증 시험', LANGUAGE_EXAM: '🌐 어학 시험',
  JOB_SEARCH: '🔍 취업 활동', JOB_TRAINING: '📚 직업 훈련', GENERAL: '📌 일반'
};

// ───────────────────────── 프롬프트 ─────────────────────────
const EVENT_SYSTEM = `너는 청년 정책 캘린더 "LifeTrigger AI"의 일정 해석기다.
사용자가 캘린더에 적은 일정 제목과 날짜만 보고, 그 일정이 사용자 본인의 어떤 활동인지 분류한다.

카테고리(하나만 고른다):
- JOB_INTERVIEW: 본인의 채용 면접(1차·2차·최종·임원·PT 면접 등). "oo 기업 최종"처럼 전형 단계만 적힌 경우도 포함
- CERT_EXAM: 국가·민간 자격증 시험(기사, 기능사, SQLD, 한국사 등)
- LANGUAGE_EXAM: 어학 시험(TOEIC, OPIc, TEPS, JLPT 등)
- JOB_SEARCH: 서류 지원, 채용 설명회, 박람회 등 취업 활동
- JOB_TRAINING: 직업 훈련, 부트캠프, 인턴, 교육 과정
- EXCLUDED: 본인이 응시·지원하는 일정이 아님(면접관, 시험 감독, 채점, 친구 면접 동행 등)
- GENERAL: 위에 해당하지 않음

examStage(시험일 때만): REGISTRATION(접수) | EXAM_DAY(시험일) | RESULT(결과 발표) | null

규칙:
- 제목에 없는 사실을 지어내지 않는다.
- 근거가 약하면 confidence를 0.6 이하로 낮춘다.
- 아래 JSON 한 개만 출력한다.
{"category":"...","examStage":null,"confidence":0.0,"reason":"한 문장"}`;

const POLICY_SYSTEM = `너는 청년 정책 캘린더 "LifeTrigger AI"의 정책 판단기다.
사용자의 일정과 개인 조건에 대해, 규칙으로 미리 거른 후보 정책 각각을 판단한다.

[원칙 5]
1. 후보 목록에 있는 정책만 판단한다. 목록 밖 정책이나 원문에 없는 조건을 만들지 않는다.
2. 모든 판단에는 원문 문장을 그대로 인용한다. evidence는 후보 원문의 연속된 부분 문자열이어야 한다(요약·변형 금지).
3. 원문에 근거가 없거나 애매하면 eligibility를 CHECK(확인 필요)로 두고, 확인할 항목을 checkItems에 적는다.
4. 사용자 정보(나이, 거주 지역, 일정 날짜·유형)만 사용한다. 소득·취업상태처럼 주어지지 않은 정보는 추정하지 않고 checkItems로 남긴다.
5. 지정한 JSON만 출력한다.

[판단 5단계]
① 관련성: 이 일정 때문에 필요한 지원인가? DIRECT(일정에 직접 쓰임: 응시료, 면접 정장·수당 등) / RELATED(간접 도움) / NONE(무관)
② 지역: 사용자의 거주 지역이 정책 대상 지역에 포함되는가?
③ 자격: 연령·거주·기타 조건 → MET(충족) / CHECK(확인 필요) / NOT_MET(원문상 명백히 불충족)
④ 신청 시기: 일정 날짜 기준으로 언제 신청해야 하는가? (사전 신청 / 응시 후 신청 / 상시 / 마감)
⑤ 제외·중복: 제외 대상, 연간 한도, 중복 수혜 제한이 원문에 있으면 note에 적는다.

[출력 형식]
{"results":[
  {"policyId":"후보의 policyId 그대로",
   "relevance":"DIRECT|RELATED|NONE",
   "eligibility":"MET|CHECK|NOT_MET",
   "timing":{"when":"BEFORE_EVENT|AFTER_EVENT|ANYTIME|CLOSED","applyBy":"YYYY-MM-DD 또는 null","text":"신청 시점 한 문장"},
   "evidence":["원문 인용 1","원문 인용 2"],
   "checkItems":["사용자가 확인할 항목"],
   "note":"한도·중복 수혜·제외 대상 안내(없으면 빈 문자열)"}
]}`;

// ───────────────────────── 공통 유틸 ─────────────────────────
const todayStr = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST
const text = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();
const cut = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
function parseJsonLoose(s) {
  const t = String(s || '').replace(/```(?:json)?/g, '').trim();
  return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
}

// ───────────────────────── ① 일정 해석 (규칙) ─────────────────────────
function interpretByRule(body) {
  const ev = body.event || {};
  const user = body.user || {};
  const title = String(ev.title || '').trim();
  const t = title.toLowerCase();
  const detectStage = s => (/접수|신청|등록/.test(s) ? 'REGISTRATION' : /발표|결과|합격/.test(s) ? 'RESULT' : 'EXAM_DAY');

  let rule = { category: 'GENERAL', examStage: null, strength: 'NONE', excluded: false, hint: '' };
  if (/면접관|감독관|시험\s*감독|채점|면접\s*동행|친구.*(면접|시험)|동생.*(면접|시험)/.test(t)) {
    rule = { category: 'GENERAL', examStage: null, strength: 'STRONG', excluded: true, hint: '제3자 관련 일정입니다' };
  } else if (['toeic', 'toefl', 'ielts', 'opic', '토익', '토플', '텝스', 'teps', 'jlpt', 'hsk', 'dele', 'delf'].some(k => t.includes(k))) {
    rule = { category: 'LANGUAGE_EXAM', examStage: detectStage(t), strength: 'STRONG', excluded: false, hint: '어학 시험' };
  } else if (['기사', '기능사', '산업기사', '자격증', 'sqld', 'sqlp', '리눅스마스터', '정보보안', '컴퓨터활용', 'mos', '한능검', '한국사'].some(k => t.includes(k))) {
    rule = { category: 'CERT_EXAM', examStage: detectStage(t), strength: 'STRONG', excluded: false, hint: '자격증 시험' };
  } else if (/면접|인터뷰/.test(t)) {
    rule = { category: 'JOB_INTERVIEW', examStage: null, strength: 'STRONG', excluded: false, hint: '취업 면접' };
  } else if (/시험|고시|필기|실기/.test(t)) {
    rule = { category: 'CERT_EXAM', examStage: detectStage(t), strength: 'WEAK', excluded: false, hint: '시험(종목 불명확)' };
  } else if (/최종|1차|2차|임원|pt|과제\s*전형|코딩\s*테스트|인적성/.test(t)) {
    rule = { category: 'JOB_INTERVIEW', examStage: null, strength: 'WEAK', excluded: false, hint: '전형 단계 표현' };
  } else if (/취업|채용|입사|지원|서류/.test(t)) {
    rule = { category: 'JOB_SEARCH', examStage: null, strength: 'WEAK', excluded: false, hint: '취업 활동' };
  } else if (/훈련|교육|부트캠프|bootcamp|인턴|연수|과정/.test(t)) {
    rule = { category: 'JOB_TRAINING', examStage: null, strength: 'WEAK', excluded: false, hint: '직업 훈련' };
  }

  return {
    event: { id: ev.id || null, title, start: ev.start || null, end: ev.end || ev.start || null, examStage: ev.examStage || rule.examStage || null },
    user: {
      age: user.age != null && user.age !== '' ? Number(user.age) : null,
      sidoCode: String(user.sidoCode || ''),
      sigunguCode: String(user.sigunguCode || '')
    },
    answers: body.answers || {},
    userCategory: ev.category && ev.category !== 'GENERAL' && LABELS[ev.category] ? ev.category : null,
    rule
  };
}

// ───────────────────────── 규칙 + AI 합의 ─────────────────────────
function decide(base, ai) {
  const { event, user, rule, userCategory, answers } = base;
  let category = null, decidedBy = '';
  const questions = [];

  if (answers.category && LABELS[answers.category]) { category = answers.category; decidedBy = 'USER_ANSWER'; }
  else if (userCategory) { category = userCategory; decidedBy = 'USER_SELECTED'; }
  else if (rule.excluded || ai.category === 'EXCLUDED') { category = 'GENERAL'; decidedBy = 'EXCLUDED'; }
  else if (rule.strength === 'STRONG' && ai.category === rule.category) { category = rule.category; decidedBy = 'RULE+AI'; }
  else if (rule.category === 'GENERAL' && ai.category === 'GENERAL') { category = 'GENERAL'; decidedBy = 'RULE+AI'; }
  else {
    const opts = [...new Set([ai.category, rule.category, 'GENERAL'].filter(c => LABELS[c]))];
    questions.push({
      key: 'category',
      question: '"' + event.title + '" 일정은 어떤 일정인가요?',
      options: opts.map(c => ({ value: c, label: LABELS[c] })),
      why: '규칙(' + (rule.hint || '단서 없음') + ')과 AI 해석(' + (ai.reason || ai.category) + ')이 달라 추천 결과가 바뀔 수 있어요.'
    });
  }

  const examStage = answers.examStage || event.examStage || ai.examStage || null;
  if (user.age == null && answers.age == null) {
    questions.push({ key: 'age', question: '만 나이를 알려주세요.', type: 'number', why: '정책마다 연령 기준이 달라요.' });
  }
  if (!user.sigunguCode && !user.sidoCode && !answers.sigunguCode && !answers.sidoCode) {
    questions.push({ key: 'sigunguCode', question: '거주하는 시·군·구를 선택해 주세요.', type: 'region', why: '지자체 정책은 거주지 기준으로 신청할 수 있어요.' });
  }

  const finalUser = {
    age: user.age != null ? user.age : (answers.age != null ? Number(answers.age) : null),
    sidoCode: user.sidoCode || answers.sidoCode || '',
    sigunguCode: user.sigunguCode || answers.sigunguCode || ''
  };
  if (!finalUser.sidoCode && finalUser.sigunguCode) finalUser.sidoCode = finalUser.sigunguCode.slice(0, 2) + '000';

  let status = 'CONFIRMED', message = '';
  if (questions.length) { status = 'NEED_INPUT'; message = '추천 전에 확인이 필요해요.'; }
  else if (category === 'GENERAL') {
    status = 'NO_RECOMMEND';
    message = decidedBy === 'EXCLUDED'
      ? '제3자 관련 일정(면접관·시험 감독 등)에는 정책 추천이 제공되지 않습니다.'
      : '일반 일정에는 정책 추천이 제공되지 않습니다. 카테고리를 변경하면 관련 정책을 확인할 수 있어요.';
  } else if (examStage === 'RESULT') {
    status = 'NO_RECOMMEND'; message = '결과 발표 일정에는 정책 추천이 제공되지 않습니다.';
  }

  return {
    status, message,
    questions: questions.slice(0, 3),
    event: Object.assign({}, event, { category, categoryLabel: LABELS[category] || null, examStage }),
    user: finalUser,
    interpretation: { decidedBy, rule, ai }
  };
}

// ───────────────────────── ② 후보 정책 선별 ─────────────────────────
// 컬럼명은 API 원본(plcyNm 등)·snake_case(policy_name 등) 어느 쪽이든 자동 인식
const normKey = k => String(k).toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
function picker(rows) {
  const byNorm = {};
  rows.slice(0, 50).forEach(r => r && Object.keys(r).forEach(k => { byNorm[normKey(k)] = k; }));
  return (aliases, contains) => {
    for (const a of aliases) { const k = byNorm[normKey(a)]; if (k) return k; }
    for (const c of contains || []) { const hit = Object.keys(byNorm).find(n => n.includes(c)); if (hit) return byNorm[hit]; }
    return null;
  };
}

const CATS = ['JOB_INTERVIEW', 'CERT_EXAM', 'LANGUAGE_EXAM', 'JOB_SEARCH', 'JOB_TRAINING'];
const KW = {
  CERT_EXAM:     { direct: /응시료|자격증|자격\s*시험|국가기술자격|시험\s*응시/, related: /역량\s*강화|스펙|교육비|수강료/ },
  LANGUAGE_EXAM: { direct: /어학|토익|toeic|토플|오픽|opic|텝스|응시료/i, related: /자격증|역량\s*강화|수강료/ },
  JOB_INTERVIEW: { direct: /면접|정장\s*대여|취업\s*날개|증명\s*사진|면접\s*수당|면접비/, related: /구직\s*활동|취업\s*준비|구직/ },
  JOB_SEARCH:    { direct: /구직\s*활동|취업\s*준비|구직\s*촉진|취업\s*지원금|구직\s*수당/, related: /일자리|채용|취업/ },
  JOB_TRAINING:  { direct: /직업\s*훈련|훈련\s*과정|부트\s*캠프|아카데미|인턴/, related: /교육|역량\s*강화|과정/ }
};

function selectCandidates(ctx, policyRows, regionRows, codeRows) {
  const today = todayStr();
  const P = picker(policyRows);
  const COL = {
    policy_id:       P(['plcyNo', 'policy_id', 'policyId', 'plcy_no', 'id']),
    title:           P(['plcyNm', 'policy_name', 'title', 'plcy_nm', '정책명']),
    provider:        P(['operInstCdNm', 'sprvsnInstCdNm', 'provider', 'institution', '운영기관명', '주관기관명']),
    summary:         P(['plcyExplnCn', 'summary', 'description', 'policy_description', '정책설명']),
    support_details: P(['plcySprtCn', 'support_details', 'support_content', '지원내용']),
    eligibility:     P(['addAplyQlfcCndCn', 'eligibility', 'qualification', 'apply_qualification', '자격조건', '신청자격']),
    exclusion:       P(['ptcpPrpTrgtCn', 'exclusion', 'exclusion_target', '참여제외대상']),
    apply_method:    P(['plcyAplyMthdCn', 'apply_method', '신청방법']),
    keywords:        P(['plcyKywdNm', 'keywords', 'keyword', '정책키워드']),
    job_code:        P(['jobCd', 'job_cd', 'job_status', 'job_status_code', 'employment_status', '취업상태']),
    min_age:         P(['sprtTrgtMinAge', 'min_age', 'age_min']),
    max_age:         P(['sprtTrgtMaxAge', 'max_age', 'age_max']),
    apply_period:    P(['aplyYmd', 'apply_period', 'aply_ymd', '신청기간']),
    apply_start:     P(['apply_start', 'apply_start_date', 'aplyBgngYmd', 'aply_bgng_ymd']),
    apply_end:       P(['apply_end', 'apply_end_date', 'aplyEndYmd', 'aply_end_ymd', 'deadline']),
    region_codes:    P(['zipCd', 'zip_cd', 'region_codes', 'region_code', 'regions', '지역코드']),
    region_names:    P(['region_names', 'region_name', 'region_nm', '지역명'], ['regionname', '지역명']),
    detail_url:      P(['refUrlAddr1', 'detail_url', 'ref_url', 'url']),
    apply_url:       P(['aplyUrlAddr', 'apply_url', 'aply_url_addr']),
    event_type:      P(['event_type', 'event_types', 'schedule_type', 'event_category', '일정유형', '이벤트유형'], ['eventtype', 'event', '일정유형', '이벤트']),
    job_relevance:   P(['job_relevance', 'employment_relevance', 'relevance', '구직관련성'], ['relevance', '관련성']),
    target_group:    P(['target_group', 'target_groups', 'target', '대상그룹'], ['targetgroup', '대상그룹'])
  };
  const get = (row, f) => (COL[f] ? row[COL[f]] : null);

  // 공통 코드: 코드값 → 코드명 / 전체 설명
  const C = picker(codeRows);
  const codeCol = C(['code', 'code_value', 'cd', 'code_id'], ['code']);
  const codeNameCol = C(['code_name', 'code_nm', 'cd_nm', 'name', 'label', '코드명', '한글명'], ['codename', 'name', 'nm', '명']);
  const codeText = {}, codeName = {};
  for (const r of codeRows) {
    const k = codeCol ? text(r[codeCol]) : '';
    if (!k) continue;
    codeText[k] = Object.values(r).map(text).join(' ');
    codeName[k] = codeNameCol ? text(r[codeNameCol]) : '';
  }
  const codeLabel = v => text(v).split(/[,|;\s]+/).filter(Boolean).map(c => codeName[c] || c).join(', ');

  // 지역 마스터: 지역코드 → 지역명
  const R = picker(regionRows);
  const rCode = R(['region_code', 'code', 'zip_cd', 'zipCd', 'stdg_cd', '지역코드'], ['code', '코드']);
  const rSido = R(['sido_name', 'sido_nm', 'ctpv_nm', 'sido', '시도명'], ['sido', 'ctpv', '시도']);
  const rSgg = R(['sigungu_name', 'sigungu_nm', 'sgg_nm', 'sigungu', '시군구명'], ['sigungu', 'sgg', '시군구']);
  const rFull = R(['full_name', 'region_name', 'full_region_name', '전체지역명'], ['full', '전체']);
  const regionName = {};
  for (const r of regionRows) {
    const code = text(rCode && r[rCode]);
    if (code) regionName[code] = text(rSgg && r[rSgg]) || text(rSido && r[rSido]) || text(rFull && r[rFull]);
  }

  // 일정 유형 / 관련성 해석
  const relOf = v => {
    const s = text(v).toUpperCase();
    if (/OUT|범위\s*밖|무관/.test(s)) return 'OUT_OF_SCOPE';
    if (/DIRECT|직접/.test(s)) return 'DIRECT';
    if (/RELATED|인접|간접|관련/.test(s)) return 'RELATED';
    if (/REVIEW|검토/.test(s)) return 'REVIEW';
    return null;
  };
  const catsOf = s => {
    const t = String(s);
    const out = CATS.filter(c => t.toUpperCase().includes(c));
    if (out.length) return out;
    if (/interview|면접/i.test(t)) out.push('JOB_INTERVIEW');
    if (/lang|어학/i.test(t)) out.push('LANGUAGE_EXAM');
    if (/cert|자격/i.test(t)) out.push('CERT_EXAM');
    if (!out.length && /exam|시험/i.test(t)) out.push('CERT_EXAM', 'LANGUAGE_EXAM');
    if (/search|구직|취업\s*활동|채용/i.test(t)) out.push('JOB_SEARCH');
    if (/training|훈련|교육/i.test(t)) out.push('JOB_TRAINING');
    return out;
  };
  const eventMapOf = v => {
    const map = {};
    if (v == null || v === '') return map;
    let obj = v;
    if (typeof v === 'string' && /^\s*[\[{]/.test(v)) { try { obj = JSON.parse(v); } catch (e) { obj = v; } }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, r] of Object.entries(obj)) catsOf(k).forEach(c => { map[c] = relOf(r) || 'RELATED'; });
      return map;
    }
    const tokens = (Array.isArray(obj) ? obj : String(obj).split(/[,|;/]+/)).map(text).filter(Boolean);
    for (const tk of tokens) catsOf(tk + ' ' + (codeText[tk] || '')).forEach(c => { map[c] = map[c] || null; });
    return map;
  };

  // 날짜
  const toDate = s => { const v = String(s || '').replace(/\D/g, ''); return v.length >= 8 ? v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8) : null; };
  const periodOf = row => {
    let start = toDate(get(row, 'apply_start')), end = toDate(get(row, 'apply_end'));
    const raw = text(get(row, 'apply_period'));
    if ((!start || !end) && raw) {
      const ds = (raw.match(/\d{4}[-.]?\d{2}[-.]?\d{2}/g) || []).map(toDate).filter(Boolean).sort();
      if (ds.length) { start = start || ds[0]; end = end || ds[ds.length - 1]; }
    }
    return { start, end };
  };
  const toCodes = v => (Array.isArray(v) ? v : String(v || '').replace(/[{}"\[\]\s]/g, '').split(',')).map(String).filter(Boolean);

  const cat = ctx.event.category;
  const kw = KW[cat];
  const { age, sidoCode, sigunguCode } = ctx.user;
  const parentCity = sigunguCode && sigunguCode.slice(-1) !== '0' ? sigunguCode.slice(0, 4) + '0' : '';
  const stats = { total: policyRows.length, noRelevance: 0, outOfScope: 0, region: 0, age: 0, closed: 0 };
  const candidates = [];

  for (const row of policyRows) {
    const id = text(get(row, 'policy_id'));
    if (!id || !kw) continue;
    const body = ['title', 'keywords', 'summary', 'support_details', 'eligibility'].map(f => text(get(row, f))).join(' ');

    const jobRel = relOf(get(row, 'job_relevance'));
    if (jobRel === 'OUT_OF_SCOPE') { stats.outOfScope++; continue; }

    const evMap = COL.event_type ? eventMapOf(get(row, 'event_type')) : {};
    let ruleRel = null;
    if (cat in evMap) ruleRel = evMap[cat] || (jobRel === 'DIRECT' || kw.direct.test(body) ? 'DIRECT' : 'RELATED');
    else if (kw.direct.test(body)) ruleRel = 'DIRECT';
    else if (!COL.event_type && kw.related.test(body) && (jobRel === 'DIRECT' || jobRel === 'RELATED')) ruleRel = 'RELATED';
    if (!ruleRel || ruleRel === 'OUT_OF_SCOPE' || (ruleRel === 'REVIEW' && !kw.direct.test(body))) { stats.noRelevance++; continue; }
    if (ruleRel === 'REVIEW') ruleRel = 'RELATED';

    const { start, end } = periodOf(row);
    if (end && end < today) { stats.closed++; continue; }

    const codes = toCodes(get(row, 'region_codes'));
    const nationwide = codes.length === 0 || codes.length >= 250;
    const regionOk = nationwide || codes.some(rc =>
      rc === sigunguCode || rc === sidoCode || (parentCity && rc === parentCity) ||
      (!sigunguCode && sidoCode && rc.slice(0, 2) === sidoCode.slice(0, 2)));
    if (!regionOk) { stats.region++; continue; }

    const minAge = Number(get(row, 'min_age')) || null;
    const maxAge = Number(get(row, 'max_age')) || null;
    if (age != null && ((minAge && age < minAge) || (maxAge && age > maxAge))) { stats.age++; continue; }

    const dbRegionNames = text(get(row, 'region_names'));
    candidates.push({
      policy_id: id,
      title: text(get(row, 'title')),
      provider: text(get(row, 'provider')),
      summary: text(get(row, 'summary')),
      support_details: text(get(row, 'support_details')),
      eligibility: text(get(row, 'eligibility')),
      exclusion: text(get(row, 'exclusion')),
      apply_method: text(get(row, 'apply_method')),
      job_status: codeLabel(get(row, 'job_code')),
      target_group: codeLabel(get(row, 'target_group')),
      min_age: minAge, max_age: maxAge,
      apply_start: start, apply_end: end,
      region_level: nationwide ? 'N' : 'L',
      region_codes: codes.join(','),
      region_names: nationwide ? '전국' : (dbRegionNames || codes.map(c => regionName[c] || c).join(', ')),
      detail_url: text(get(row, 'detail_url')),
      apply_url: text(get(row, 'apply_url')),
      job_relevance: jobRel,
      rule_relevance: ruleRel
    });
  }

  candidates.sort((a, b) =>
    (a.rule_relevance === 'DIRECT' ? 0 : 1) - (b.rule_relevance === 'DIRECT' ? 0 : 1) ||
    String(a.apply_end || '9999-12-31').localeCompare(String(b.apply_end || '9999-12-31')));
  const picked = candidates.slice(0, MAX_CANDIDATES);

  return {
    candidates: picked,
    debug: {
      columnMap: COL,
      regionColumns: { code: rCode, sido: rSido, sigungu: rSgg, full: rFull },
      commonCodeColumns: { code: codeCol, name: codeNameCol },
      counts: Object.assign(stats, { matched: candidates.length, sentToAi: picked.length, regions: regionRows.length, commonCodes: codeRows.length })
    }
  };
}

function candidatesForAi(picked) {
  return picked.map(p => ({
    policyId: p.policy_id,
    title: p.title,
    provider: p.provider,
    ruleRelevance: p.rule_relevance,
    region: p.region_names,
    age: (p.min_age || '-') + '~' + (p.max_age || '-'),
    jobStatus: p.job_status || '제한 없음/미기재',
    targetGroup: p.target_group || '',
    applyPeriod: p.apply_start || p.apply_end ? (p.apply_start || '') + ' ~ ' + (p.apply_end || '') : '상시/미기재',
    summary: cut(p.summary, 500),
    supportDetails: cut(p.support_details, 700),
    eligibility: cut(p.eligibility, 700),
    exclusion: cut(p.exclusion, 400)
  }));
}

// ───────────────────────── ③ 결과 정리 ─────────────────────────
function buildResult(ctx, picked, judged, debug) {
  const today = todayStr();
  const byId = Object.fromEntries(picked.map(p => [p.policy_id, p]));
  const norm = s => String(s || '').replace(/\s+/g, '');
  const STATUS_LABELS = { OPEN: '모집중', UPCOMING: '예정', CLOSED: '마감', UNKNOWN: '상시/미확인' };
  const REL_LABELS = { DIRECT: '직접 연관', RELATED: '관련 정책' };
  const ELIG_LABELS = { MET: '충족', CHECK: '확인 필요', NOT_MET: '불충족' };
  const statusOf = p => {
    if (!p.apply_start && !p.apply_end) return 'UNKNOWN';
    if (p.apply_end && p.apply_end < today) return 'CLOSED';
    if (p.apply_start && p.apply_start > today) return 'UPCOMING';
    return 'OPEN';
  };

  const cards = new Map();
  const hidden = { notRelated: 0, notEligible: 0, outsideCandidates: 0 };
  for (const j of judged) {
    const p = byId[j.policyId];
    if (!p) { hidden.outsideCandidates++; continue; }
    if (j.relevance === 'NONE') { hidden.notRelated++; continue; }
    if (j.eligibility === 'NOT_MET') { hidden.notEligible++; continue; }

    const original = norm([p.title, p.summary, p.support_details, p.eligibility, p.exclusion, p.apply_method].join(' '));
    const evidence = (j.evidence || []).filter(q => q && original.includes(norm(q)));
    const eligibility = evidence.length || j.eligibility === 'CHECK' ? (j.eligibility === 'MET' ? 'MET' : 'CHECK') : 'CHECK';
    const status = statusOf(p);
    const rel = j.relevance === 'DIRECT' ? 'DIRECT' : 'RELATED';
    const card = {
      id: p.policy_id, title: p.title, provider: p.provider,
      url: p.detail_url, applyUrl: p.apply_url,
      summary: p.summary || p.support_details, supportDetails: p.support_details, eligibilityText: p.eligibility,
      regionLevel: p.region_level, regionNames: p.region_level === 'N' ? '전국' : (p.region_names || p.region_codes),
      status, statusLabel: STATUS_LABELS[status], applyStart: p.apply_start, applyEnd: p.apply_end,
      relevance: rel, relevanceLabel: REL_LABELS[rel],
      eligibility, eligibilityLabel: ELIG_LABELS[eligibility],
      checkItems: j.checkItems || [], timing: j.timing || null, evidence, note: j.note || ''
    };
    const key = norm(p.title) + '|' + norm(p.provider);
    const prev = cards.get(key);
    if (!prev || (prev.relevance !== 'DIRECT' && card.relevance === 'DIRECT')) cards.set(key, card);
  }

  const relOrder = { DIRECT: 0, RELATED: 1 };
  const statusOrder = { OPEN: 0, UPCOMING: 1, UNKNOWN: 2, CLOSED: 3 };
  const list = [...cards.values()].sort((a, b) =>
    (relOrder[a.relevance] - relOrder[b.relevance]) ||
    (statusOrder[a.status] - statusOrder[b.status]) ||
    String(a.applyEnd || '9999-12-31').localeCompare(String(b.applyEnd || '9999-12-31')) ||
    a.title.localeCompare(b.title, 'ko'));

  const notices = [];
  const feeCards = list.filter(c => /응시료/.test(c.title + c.supportDetails));
  if (feeCards.length > 1) notices.push('응시료 지원 정책이 ' + feeCards.length + '건입니다. 대부분 중복 수혜가 제한되니 원문의 한도·중복 조건을 확인하세요.');

  return {
    status: 'OK',
    event: ctx.event,
    user: ctx.user,
    count: list.filter(c => c.status !== 'CLOSED').length,
    policies: list.filter(c => c.status !== 'CLOSED'),
    closedPolicies: list.filter(c => c.status === 'CLOSED'),
    hidden, notices,
    disclaimer: '추천은 1차 판단이며, 실제 신청 자격과 운영 여부는 정책 원문에서 확인하세요.',
    generatedAt: new Date().toISOString(),
    debug: Object.assign({}, debug, { judgedByAi: judged.length })
  };
}

// ───────────────────────── 전체 흐름 ─────────────────────────
// deps = { loadTables(): {policies, regions, codes}, llm(system, user, maxTokens): string }
async function recommend(body, deps) {
  const base = interpretByRule(body);

  // ① 일정 해석 (AI) — 사용자가 이미 고른/답한 카테고리가 있으면 생략
  let ai = { category: 'GENERAL', examStage: null, confidence: 0, reason: '' };
  if (!base.userCategory && !(base.answers && base.answers.category) && !base.rule.excluded) {
    try {
      const out = await deps.llm(EVENT_SYSTEM,
        '일정 제목: ' + base.event.title + '\n일정 날짜: ' + (base.event.start || '') + '\n사용자가 고른 카테고리: 없음', 512);
      ai = Object.assign(ai, parseJsonLoose(out));
    } catch (e) { ai.reason = 'AI 해석 실패: ' + e.message; }
  }

  const ctx = decide(base, ai);
  if (ctx.status !== 'CONFIRMED') return ctx;

  // ② 후보 선별
  const t = await deps.loadTables();
  const { candidates, debug } = selectCandidates(ctx, t.policies, t.regions, t.codes);
  if (!candidates.length) {
    return Object.assign({}, ctx, { status: 'NO_CANDIDATES', message: '조건에 맞는 정책을 찾지 못했습니다. 지역 설정을 변경해 보세요.', policies: [], debug });
  }

  // AI 판단 5단계
  const userMsg = '[사용자 일정]\n- 제목: ' + ctx.event.title +
    '\n- 유형: ' + ctx.event.categoryLabel + ' ' + (ctx.event.examStage || '') +
    '\n- 날짜: ' + (ctx.event.start || '') +
    '\n- 오늘: ' + todayStr() +
    '\n\n[사용자 조건]\n- 만 나이: ' + ctx.user.age +
    '\n- 거주 시도코드: ' + ctx.user.sidoCode + ' / 시군구코드: ' + ctx.user.sigunguCode +
    '\n\n[후보 정책 ' + candidates.length + '건 — 이 목록 밖은 판단하지 않는다]\n' + JSON.stringify(candidatesForAi(candidates));
  let judged = [];
  try { judged = parseJsonLoose(await deps.llm(POLICY_SYSTEM, userMsg, 8192)).results || []; }
  catch (e) { debug.aiError = e.message; }

  // ③ 결과 정리
  return buildResult(ctx, candidates, judged, debug);
}

// ───────────────────────── 외부 연동 (Supabase · Gemini) ─────────────────────────
let tableCache = null;
async function supabaseAll(table) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const rows = [];
  const page = 1000;
  for (let from = 0; from < 20000; from += page) {
    const r = await fetch(url + '/rest/v1/' + table + '?select=*', {
      headers: { apikey: key, Authorization: 'Bearer ' + key, Range: from + '-' + (from + page - 1), 'Range-Unit': 'items' }
    });
    if (!r.ok) throw new Error('Supabase ' + table + ' 조회 실패 (' + r.status + '): ' + (await r.text()).slice(0, 200));
    const chunk = await r.json();
    rows.push(...chunk);
    if (chunk.length < page) break;
  }
  return rows;
}
async function loadTables() {
  if (tableCache && Date.now() - tableCache.at < CACHE_TTL_MS) return tableCache.data;
  const [policies, regions, codes] = await Promise.all([
    supabaseAll('lt_policies'),
    supabaseAll('lt_regions'),
    supabaseAll('lt_common_codes').catch(() => [])
  ]);
  tableCache = { at: Date.now(), data: { policies, regions, codes } };
  return tableCache.data;
}
async function gemini(system, user, maxTokens) {
  const model = process.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY || '' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: 'application/json' }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Gemini 오류 (' + r.status + '): ' + ((j.error && j.error.message) || '').slice(0, 200));
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}

// ───────────────────────── HTTP 핸들러 ─────────────────────────
async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ALIVE',
      service: 'LifeTrigger AI 정책 추천 API',
      env: {
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_KEY: !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY),
        GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
        GEMINI_MODEL: process.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT
      }
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ status: 'ERROR', message: 'POST 로 요청하세요.' });

  const missing = ['SUPABASE_URL', 'GEMINI_API_KEY'].filter(k => !process.env[k]);
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_ANON_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) return res.status(500).json({ status: 'ERROR', message: 'Vercel 환경변수가 없습니다: ' + missing.join(', ') });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  try {
    const out = await recommend(body || {}, { loadTables, llm: gemini });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ status: 'ERROR', message: e.message });
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
module.exports._test = { interpretByRule, decide, selectCandidates, buildResult, recommend };
