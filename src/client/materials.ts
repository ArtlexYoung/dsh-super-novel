export const materialKinds = ['seed', 'book-card', 'character', 'world', 'outline', 'chapter-outline', 'scene']
const fields = {
  zh: {
    seed: ['故事想法'], 'book-card': ['题材', '核心冲突', '主角', '目标', '叙述视角'], character: ['姓名', '目标', '动机', '秘密', '关系'],
    world: ['地点', '时代', '规则', '限制'], outline: ['开端', '主要转折', '结局方向'], 'chapter-outline': ['本章目标', '阻力', '转折', '后果'],
    scene: ['视角', '目的', '公开目标', '私有意图', '已知事实', '阻力', '转折', '代价', '后果', '地点', '时间'],
  },
  en: {
    seed: ['Story idea'], 'book-card': ['Genre', 'Central conflict', 'Protagonist', 'Goal', 'Viewpoint'], character: ['Name', 'Goal', 'Motivation', 'Secret', 'Relationships'],
    world: ['Location', 'Period', 'Rules', 'Limits'], outline: ['Opening', 'Turning points', 'Ending direction'], 'chapter-outline': ['Chapter goal', 'Resistance', 'Turn', 'Consequences'],
    scene: ['Viewpoint', 'Purpose', 'Public goal', 'Private intent', 'Known facts', 'Resistance', 'Turn', 'Cost', 'Consequences', 'Location', 'Time'],
  },
}
export function materialTemplate(kind, language) { return (fields[language]?.[kind] ?? []).map(field => `## ${field}\n\n`).join('') }

export function materialInstruction(kind, language) {
  const headings = (fields[language]?.[kind] ?? fields.en[kind] ?? []).join(language === 'zh' ? '、' : ', ')
  return language === 'zh'
    ? `生成或完善一份可供写作引用的资料，用 Markdown 小标题组织，包含：${headings}。保留已有明确设定，写出具体、可修改的内容。引用正文时区分原文已有信息、未知项和建议新增设定；规划中的未来事件不能写成已发生事实。只返回资料内容。`
    : `Create or improve a usable writing reference in Markdown, with sections for: ${headings}. Keep explicit existing settings and provide concrete, editable details. When using saved prose, separate information in the text, unknowns, and suggested additions. Planned events are not established facts. Return only the material.`
}

export function materialSources(book, targetId = '', includeChapters = false) {
  return book.chapters.filter(item => item.chapterId !== targetId && item.kind !== 'facts' && item.kind !== 'voice' &&
    (includeChapters || item.kind && item.kind !== 'chapter'))
}
