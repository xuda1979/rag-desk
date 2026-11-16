'use strict';

/**
 * Domain presets (法律/医疗/招采) as prompt/template packs.
 * Each pack configures how the offline "retrieved-excerpt + rules" answer is
 * phrased. When an optional LLM summarizer is enabled these also seed the
 * system prompt.
 */

const DOMAINS = {
  legal: {
    id: 'legal',
    label: '法律 · 律师事务所',
    greeting: '您好，我是律所智能问答助手。您可以询问合同、诉讼流程、收费标准、法律法规等问题。',
    lead: '根据律所知识库，下面是一段与您问题直接相关的原文片段：',
    fallback: '抱歉，我在知识库中暂未找到与您问题直接相关的内容。您可以换个问法，或咨询前台获取人工帮助。',
    footer: '（以上回答基于律所公开资料整理，如有紧急法律问题请咨询执业律师。）',
    systemPrompt:
      '你是一名律师事务所的客服助手。仅依据提供的上下文原文回答，不要编造事实；' +
      '必要时提示用户咨询执业律师；回答使用简体中文，引用原文中的关键信息。',
    exampleQuestions: [
      '律师咨询费怎么收取？',
      '劳动仲裁的流程是什么？',
      '合同纠纷可以起诉吗？',
    ],
  },

  medical: {
    id: 'medical',
    label: '医疗 · 诊所',
    greeting: '您好，我是诊所在线导诊助手。可以询问挂号、科室、复诊流程与医保报销等问题。',
    lead: '根据诊所资料，以下是与您关心问题相关的原文内容：',
    fallback: '很抱歉，目前的知识库中还没有相关内容。您可以致电诊所前台，或描述得更具体一些。',
    footer: '（以上内容仅供参考，不能替代医生当面诊断。）',
    systemPrompt:
      '你是一名诊所的在线导诊客服。只依据提供的上下文原文回答，不提供药物或诊疗建议；' +
      '急症请提醒用户立即就医；回答使用简体中文并引用原文关键信息。',
    exampleQuestions: [
      '挂号需要带什么？',
      '儿童接种疫苗时间？',
      '可以刷医保卡吗？',
    ],
  },

  procurement: {
    id: 'procurement',
    label: '招采 · 中标公告',
    greeting: '您好，这里是招投标信息助手。可以查询公告要点、投标要求、截止时间与联系方式。',
    lead: '根据发布的公告原文，相关要点如下：',
    fallback: '抱歉，我还没有检索到相关的公告内容。您可以提供项目名称关键词，我再帮您查找。',
    footer: '（公告信息以官方发布文件为准。）',
    systemPrompt:
      '你是一名政府采购与中标公告信息助手。只依据提供的公告原文回答，区分"公告发布"与"中标结果"；' +
      '明确给出各项时间与联系方式；回答使用简体中文并引用原文。',
    exampleQuestions: [
      '这个项目什么时候截止投标？',
      '中标人是谁？',
      '项目预算金额是多少？',
    ],
  },

  general: {
    id: 'general',
    label: '通用 · General',
    greeting: '您好，这是您专属的知识库问答助手。',
    lead: '以下是知识库中与您问题最相关的原文片段：',
    fallback: '抱歉，知识库中没有找到相关内容。',
    footer: '',
    systemPrompt:
      '你是知识库问答助手。仅依据提供的上下文原文回答，回答使用简体中文，必要时注明来源。',
    exampleQuestions: [],
  },
};

function getDomain(id) {
  return DOMAINS[id] || DOMAINS.general;
}

function domainIds() {
  return Object.keys(DOMAINS);
}

module.exports = { DOMAINS, getDomain, domainIds };
