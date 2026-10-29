import { normalizeAnchorText } from '@bookorbit/types'

export function verifiesAnnotationRange(range: Range | undefined, expected: string, budgetMs = 10): boolean {
  if (!range || range.collapsed || expected.length > 16_384) return false
  try {
    const normalized = normalizeAnchorText(expected)
    if (!normalized) return false
    const deadline = performance.now() + budgetMs
    const root = range.commonAncestorContainer
    const document = root.ownerDocument
    if (!document) return false
    const walker = document.createTreeWalker(root, 4)
    const parts: string[] = []
    let node: Node | null = root.nodeType === 3 ? root : walker.nextNode()
    let length = 0
    let visited = 0
    while (node) {
      if (++visited > 2_000 || performance.now() >= deadline) return false
      if (range.intersectsNode(node)) {
        const text = node.nodeValue ?? ''
        const start = node === range.startContainer ? range.startOffset : 0
        const end = node === range.endContainer ? range.endOffset : text.length
        length += end - start
        if (length > 16_384) return false
        parts.push(text.slice(start, end))
      }
      node = walker.nextNode()
    }
    return normalizeAnchorText(parts.join('')) === normalized
  } catch {
    return false
  }
}
