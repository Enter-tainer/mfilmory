import { isTaggedFunctionCallOf } from 'ast-kit'
import type { Transformer } from 'unplugin-ast'
import AST from 'unplugin-ast/vite'

// Custom transformer for tw function that compresses template strings
const TwTransformer: Transformer<any> = {
  // unplugin-ast 的 node 是 `@yuku-toolchain/types` 的 Program，而 ast-kit 的
  // `isTaggedFunctionCallOf` 收的是 `@babel/types` 的 Node —— 两个包的 AST 类型
  // 结构一致但声明不兼容，这里显式放宽成 any（只做一次带 tag 名的属性判断）。
  onNode: (node: any) => isTaggedFunctionCallOf(node, ['tw']),
  transform(node) {
    if (node.type === 'TaggedTemplateExpression') {
      const { quasi } = node

      // Process template literals
      if (quasi.type === 'TemplateLiteral') {
        // Get the raw string content
        const rawString = quasi.quasis[0]?.value?.raw || ''

        // Compress the string: remove extra whitespace, newlines, and normalize spaces
        const compressedString = rawString
          .replaceAll(/\s+/g, ' ') // Replace multiple whitespace with single space
          .trim() // Remove leading and trailing whitespace

        // Update the template literal
        quasi.quasis[0].value.raw = compressedString
        quasi.quasis[0].value.cooked = compressedString
      }

      return quasi
    }
    return node.arguments[0]
  },
}

export const astPlugin = AST({
  transformer: [TwTransformer],
})
