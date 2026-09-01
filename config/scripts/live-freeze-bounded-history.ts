export class BoundedLiveFreezeHistory<T> {
  #entries: T[] = []
  #limit: number
  #nextIndex = 0
  #totalCount = 0

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`History limit must be a positive integer, got ${limit}`)
    }
    this.#limit = limit
  }

  add(entry: T) {
    this.#totalCount += 1
    if (this.#entries.length < this.#limit) {
      this.#entries.push(entry)
      return
    }
    this.#entries[this.#nextIndex] = entry
    this.#nextIndex = (this.#nextIndex + 1) % this.#limit
  }

  get retainedCount() {
    return this.#entries.length
  }

  get totalCount() {
    return this.#totalCount
  }

  values() {
    if (this.#entries.length < this.#limit || this.#nextIndex === 0) {
      return [...this.#entries]
    }
    return [...this.#entries.slice(this.#nextIndex), ...this.#entries.slice(0, this.#nextIndex)]
  }
}
