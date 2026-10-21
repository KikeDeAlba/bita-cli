import readline from 'node:readline'

export async function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  const output = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (value: string) => void }

  return new Promise((resolve) => {
    let muted = false
    output._writeToOutput = (value: string): void => {
      if (!muted) process.stderr.write(value)
    }
    rl.question(question, (answer) => {
      muted = false
      process.stderr.write('\n')
      rl.close()
      resolve(answer.trim())
    })
    muted = true
  })
}

export async function promptConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close()
      resolve(/^y(es)?$/i.test(answer.trim()))
    })
  })
}

export async function promptText(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}
