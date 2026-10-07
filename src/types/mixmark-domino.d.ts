declare module '@mixmark-io/domino' {
  export interface DomNode {
    readonly nodeType: number
    readonly nodeName: string
    textContent: string | null
    readonly parentNode: DomNode | null
    readonly childNodes: ArrayLike<DomNode>
    readonly nextSibling: DomNode | null
    insertBefore(node: DomNode, reference: DomNode | null): DomNode
    removeChild(node: DomNode): DomNode
    replaceChild(node: DomNode, old: DomNode): DomNode
    appendChild(node: DomNode): DomNode
  }

  export interface DomElement extends DomNode {
    readonly localName: string
    readonly children: ArrayLike<DomElement>
    innerHTML: string
    getAttribute(name: string): string | null
    setAttribute(name: string, value: string): void
  }

  export interface DomDocument {
    readonly body: DomElement
    createElement(tag: string): DomElement
    createTextNode(text: string): DomNode
  }

  const domino: {
    createDocument(html?: string, force?: boolean): DomDocument
  }
  export default domino
}
