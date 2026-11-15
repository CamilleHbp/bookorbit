import type { CompilerOptions } from 'vue/compiler-sfc'

/** Apply literal-text defaults at compilation so raw inputs and shared controls behave alike. */
export const inputDefaults: NonNullable<CompilerOptions['nodeTransforms']>[number] = (node) => {
  if (!('tag' in node)) return
  const literalTextarea =
    node.tag === 'textarea' && node.props.some((prop) => prop.type === 6 && prop.name === 'spellcheck' && prop.value?.content === 'false')
  if (node.tag !== 'input' && !literalTextarea) return
  const type = node.props.find((prop) => prop.type === 6 && prop.name === 'type')
  if (type?.type === 6 && type.value && !['text', 'search', 'email', 'url', 'tel', 'password'].includes(type.value.content)) return

  for (const [name, value] of Object.entries({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' })) {
    const configured = node.props.some(
      (prop) =>
        (prop.type === 6 && prop.name === name) ||
        (prop.type === 7 && prop.name === 'bind' && prop.arg?.type === 4 && prop.arg.isStatic && prop.arg.content === name),
    )
    if (configured) continue
    node.props.unshift({ type: 6, name, nameLoc: node.loc, value: { type: 2, content: value, loc: node.loc }, loc: node.loc })
  }
}
