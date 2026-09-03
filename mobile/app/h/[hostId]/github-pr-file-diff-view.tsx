import { useMemo, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors } from '../../../src/theme/colors'
import { typography } from '../../../src/theme/typography'
import { MobileSyntaxSegments } from '../../../src/components/MobileSyntaxSegments'
import {
  buildGitHubPrFileDiffPreview,
  type GitHubPrFileDiffLine
} from '../../../src/tasks/github-pr-file-diff'
import {
  highlightMobileDiffLines,
  resolveMobileSyntaxLanguage
} from '../../../src/files/mobile-file-preview-syntax'
import type { GitHubPRFileContents } from './tasks-types-all'

const MAX_RENDERED_PR_DIFF_LINES = 400

function formatDiffLineNumber(value: number | undefined): string {
  return value === undefined ? '    ' : value.toString().padStart(4, ' ')
}

function diffLinePrefix(kind: GitHubPrFileDiffLine['kind']): string {
  if (kind === 'added') {
    return '+'
  }
  if (kind === 'removed') {
    return '-'
  }
  return ' '
}

function GitHubPrFileDiff({
  filePath,
  contents,
  commentDrafts,
  disabled,
  onCommentDraftChange,
  onSubmitComment
}: {
  filePath: string
  contents: GitHubPRFileContents
  commentDrafts: Record<string, string>
  disabled: boolean
  onCommentDraftChange: (key: string, value: string) => void
  onSubmitComment: (line: number) => void
}): ReactNode {
  const diffPreview = useMemo(
    () =>
      buildGitHubPrFileDiffPreview(
        contents.original,
        contents.modified,
        MAX_RENDERED_PR_DIFF_LINES
      ),
    [contents.modified, contents.original]
  )
  const syntaxLanguage = useMemo(() => resolveMobileSyntaxLanguage(filePath), [filePath])
  const visibleDiffLines = useMemo(
    () => highlightMobileDiffLines(diffPreview.lines, syntaxLanguage),
    [diffPreview.lines, syntaxLanguage]
  )
  const hiddenDiffLineCount = Math.max(0, diffPreview.totalLineCount - visibleDiffLines.length)

  if (diffPreview.totalLineCount === 0) {
    return <Text style={styles.detailMuted}>No text changes found.</Text>
  }

  return (
    <View style={styles.fileDiff}>
      {hiddenDiffLineCount > 0 ? (
        <Text style={styles.detailMuted}>
          Showing first {MAX_RENDERED_PR_DIFF_LINES} of {diffPreview.totalLineCount} diff lines.
        </Text>
      ) : null}
      {visibleDiffLines.map((line) => {
        const commentLine = line.kind === 'removed' ? undefined : line.newLineNumber
        const draftKey = commentLine === undefined ? '' : `${filePath}:${commentLine}`
        return (
          <View
            key={line.key}
            style={[
              styles.diffLineBlock,
              line.kind === 'added'
                ? styles.diffLineAdded
                : line.kind === 'removed'
                  ? styles.diffLineRemoved
                  : null
            ]}
          >
            <View style={styles.diffCodeRow}>
              <Text style={styles.diffLineNumbers}>
                {formatDiffLineNumber(line.oldLineNumber)}{' '}
                {formatDiffLineNumber(line.newLineNumber)}
              </Text>
              <Text
                style={[
                  styles.codeLine,
                  line.kind === 'added'
                    ? styles.diffCodeAdded
                    : line.kind === 'removed'
                      ? styles.diffCodeRemoved
                      : null
                ]}
              >
                <Text>{diffLinePrefix(line.kind)} </Text>
                <MobileSyntaxSegments segments={line.segments} />
                {line.text ? null : ' '}
              </Text>
            </View>
            {commentLine !== undefined ? (
              <>
                <TextInput
                  style={[styles.input, styles.replyInput]}
                  value={commentDrafts[draftKey] ?? ''}
                  onChangeText={(next) => onCommentDraftChange(draftKey, next)}
                  placeholder="Add review comment"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  textAlignVertical="top"
                />
                <Pressable
                  style={styles.inlineSaveButtonCompact}
                  disabled={disabled || !(commentDrafts[draftKey] ?? '').trim()}
                  onPress={() => onSubmitComment(commentLine)}
                >
                  <Text style={styles.inlineSaveText}>Comment on line {commentLine}</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  detailMuted: {
    color: colors.textMuted,
    fontSize: typography.captionSize
  },
  fileDiff: {
    gap: 4
  },
  diffLineBlock: {
    borderRadius: 4,
    paddingVertical: 1
  },
  diffLineAdded: {
    backgroundColor: 'rgba(34, 197, 94, 0.12)'
  },
  diffLineRemoved: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)'
  },
  diffCodeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start'
  },
  diffLineNumbers: {
    width: 68,
    fontFamily: typography.fontMono,
    fontSize: typography.captionSize - 1,
    color: colors.textMuted
  },
  codeLine: {
    flex: 1,
    fontFamily: typography.fontMono,
    fontSize: typography.captionSize - 1,
    color: colors.textPrimary
  },
  diffCodeAdded: {
    color: colors.accentGreen
  },
  diffCodeRemoved: {
    color: colors.accentRed
  },
  input: {
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  replyInput: {
    minHeight: 64,
    marginTop: 6
  },
  inlineSaveButtonCompact: {
    backgroundColor: colors.accentBlue,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    alignSelf: 'flex-end',
    marginTop: 6
  },
  inlineSaveText: {
    color: colors.bgBase,
    fontSize: typography.captionSize,
    fontWeight: '600'
  }
})

export { GitHubPrFileDiff }
