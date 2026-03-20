import { DatabaseModel, SearchResult, ChatMessage } from '../models/database.model';
import { EmbeddingService } from './embedding.service';
import { NeighborChunkService } from './neighbor-chunk.service';

type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export class RAGService {
  private openaiBaseUrl: string;
  private openaiTimeoutMs: number;
  private neighborChunkService: NeighborChunkService;

  constructor(
    private db: DatabaseModel,
    private embeddingService: EmbeddingService,
    private openaiApiKey: string,
    private openaiChatModel: string,
    openaiBaseUrl?: string,
    openaiTimeoutMs?: number
  ) {
    this.openaiBaseUrl = (openaiBaseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    this.openaiTimeoutMs = openaiTimeoutMs ?? 60_000;
    this.neighborChunkService = new NeighborChunkService(db);
  }

  /* =====================================================
     MAIN ENTRY - Metadata-aware + Hybrid Search
  ====================================================== */
  async chat(messages: ChatMessage[], expandedQueries?: string[] | null): Promise<string> {
    const userMessage = messages.filter(m => m.role === 'user').pop();
    if (!userMessage) {
      return 'Không có câu hỏi hợp lệ.';
    }

    const query = userMessage.content.trim();
    console.log('\n🔥 RAGService.chat()');
    console.log('🔍 Query:', query);

    // 1. Detect intent & metadata filters
    const filters = this.detectQueryIntent(query);
    console.log('🎯 Detected filters:', filters);

    // 🆕 2. HYBRID APPROACH: Check for teaching list query
    if (filters.query_type === 'teaching_list') {
      const instructorName = this.extractInstructorName(query);
      
      if (instructorName) {
        console.log(`🎓 Teaching list query detected for: ${instructorName}`);
        
        // Try TWO-PASS search first (more accurate)
        let metadataResults = await this.db.searchByInstructorTwoPass(
          instructorName,
          { document_type: 'syllabus', limit: 50 }
        );
        
        // Fallback to single-pass if two-pass returns nothing
        if (metadataResults.length === 0) {
          console.log('⚠️ Two-pass search returned 0, trying single-pass...');
          metadataResults = await this.db.searchByInstructor(
            instructorName,
            { document_type: 'syllabus', limit: 50 }
          );
        }
        
        // If we found >= 2 subjects from metadata → Direct response
        if (metadataResults.length >= 2) {
          console.log(`✅ Found ${metadataResults.length} subjects via metadata search`);
          return await this.buildTeachingListResponse(instructorName, metadataResults);
        }
        
        // If < 2 subjects → Fallback to semantic search with high chunk limit
        console.log(`⚠️ Metadata search insufficient (${metadataResults.length} results), using semantic search`);
      }
    }

    // 3. Generate embeddings (query + optional expanded queries)
    const candidateQueries = [query, ...(expandedQueries || [])]
      .map(q => String(q || '').trim())
      .filter(Boolean)
      .slice(0, 5); // keep it bounded

    const rawChunksById = new Map<string, SearchResult>();
    let embeddingForFollowups: number[] | null = null;

    for (const candidate of candidateQueries) {
      const embedding = await this.embeddingService.generateEmbedding(candidate);
      if (!embeddingForFollowups && candidate === query) {
        embeddingForFollowups = embedding;
      }

      const results = await this.db.searchSimilarChunks(embedding, 15, filters);
      for (const r of results) {
        if (!rawChunksById.has(r.chunk_id)) {
          rawChunksById.set(r.chunk_id, r);
        }
      }
    }

    // Default to the original query embedding for later expansions (syllabus → subject search)
    const embedding = embeddingForFollowups ?? (await this.embeddingService.generateEmbedding(query));

    const rawChunks = [...rawChunksById.values()];

    console.log(`📊 Retrieved ${rawChunks.length} chunks`);

    rawChunks.forEach((c, i) => {
      console.log(
        `#${i + 1} | ${(c.similarity * 100).toFixed(1)}% | ${c.document_type} | ${c.metadata?.source_file}`
      );
    });

    if (rawChunks.length === 0) {
      return this.noContext();
    }

    // 4. Re-rank với metadata awareness
    let reranked = this.rerankWithMetadata(rawChunks, query);

    const fileMention = this.detectMentionedSourceFile(query, reranked);
    if (fileMention) {
      reranked = reranked.filter(c => c.metadata?.source_file === fileMention);
      console.log(`INFO: Restricting to source file: ${fileMention}`);
    }

    let expandedBySubject = false;
    const topAfterFilter = reranked[0];
    if (topAfterFilter?.document_type === 'syllabus' && this.queryMentionsSubject(query, topAfterFilter.metadata)) {
      const subjectFilters = topAfterFilter.metadata.subject_code
        ? { metadata_filters: { subject_code: topAfterFilter.metadata.subject_code } }
        : { metadata_filters: { subject_name: topAfterFilter.metadata.subject_name } };

      const subjectChunks = await this.db.searchSimilarChunks(
        embedding,
        100,
        subjectFilters
      );

      if (subjectChunks.length > 0) {
        reranked = this.rerankWithMetadata(subjectChunks, query);
        expandedBySubject = true;
        console.log(`INFO: Expanded to ${subjectChunks.length} chunks for subject`);
      }
    }

    console.log('\n🔁 Top 5 after re-rank:');
    reranked.slice(0, 5).forEach((c, i) => {
      console.log(
        `#${i + 1} | ${(c.similarity * 100).toFixed(1)}% | ${c.document_type} | ${c.metadata?.source_file}`
      );
    });

    // 5. Threshold filtering
    // Lower thresholds to avoid dropping relevant context too aggressively after re-ranking.
    const MIN_TOP = 0.38;
    const MIN_CHUNK = 0.32;

    const top = reranked[0];
    if (top.similarity < MIN_TOP) {
      console.log('❌ Similarity too low');
      return this.noContext();
    }

    // 🆕 Dynamic chunk selection based on query type
    let chunkLimit = 4; // default
    
    if (filters.query_type === 'teaching_list') {
      chunkLimit = 20; // High limit for teaching list queries
      console.log('📚 Teaching list query → using 20 chunks');
    } else if (expandedBySubject) {
      chunkLimit = 8;
    }

    const selectedChunks = expandedBySubject || filters.query_type === 'teaching_list'
      ? reranked.slice(0, chunkLimit)
      : reranked.filter(c => c.similarity >= MIN_CHUNK).slice(0, chunkLimit);

    console.log(`✅ Selected ${selectedChunks.length} chunks for context`);

    if (selectedChunks.length === 0) {
      return this.noContext();
    }

    // 6. Expand neighbor chunks (more complete context)
    const neighborWindow = Math.max(
      0,
      Number.parseInt(process.env.NEIGHBOR_CHUNK_WINDOW || '1', 10) || 1
    );
    const expandedChunks = await this.neighborChunkService.expand(selectedChunks, neighborWindow);

    // 7. Build context
    const context = this.buildContextWithMetadata(expandedChunks);

    console.log('\n🧠 CONTEXT LENGTH:', context.length);

    if (context.length < 50) {
      return this.noContext();
    }

    // 8. Generate response
    return await this.generateResponse(query, context, expandedChunks, filters.query_type);
  }

  /* =====================================================
     🆕 BUILD TEACHING LIST RESPONSE (Metadata-based)
  ====================================================== */
  private async buildTeachingListResponse(
    instructorName: string,
    chunks: SearchResult[]
  ): Promise<string> {
    // Extract unique subjects from metadata
    const subjectsMap = new Map<string, { name: string; code?: string }>();
    
    for (const chunk of chunks) {
      const meta = chunk.metadata;
      const subjectName = meta?.subject_name;
      const subjectCode = meta?.subject_code;
      
      if (subjectName) {
        const key = subjectCode || subjectName;
        if (!subjectsMap.has(key)) {
          subjectsMap.set(key, {
            name: subjectName,
            code: subjectCode
          });
        }
      }
    }

    if (subjectsMap.size === 0) {
      return `Không tìm thấy thông tin về các môn học mà giảng viên ${instructorName} giảng dạy trong phần "Giảng viên giảng dạy học phần".`;
    }

    // Format response
    const subjectList = Array.from(subjectsMap.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => s.code ? `${s.name} (${s.code})` : s.name)
      .map((s, i) => `${i + 1}. ${s}`)
      .join('\n');

    const disclaimer = subjectsMap.size === 1 
      ? '\n\n_Lưu ý: Chỉ tìm thấy 1 môn học. Có thể giảng viên còn phụ trách các môn khác chưa có trong hệ thống._'
      : '\n\n_Thông tin trích từ phần "Giảng viên giảng dạy học phần" trong các đề cương môn học._';

    return `Dựa trên các đề cương môn học, giảng viên **${instructorName}** giảng dạy ${subjectsMap.size} môn:\n\n${subjectList}${disclaimer}`;
  }

  /* =====================================================
     QUERY INTENT DETECTION (Enhanced)
  ====================================================== */
  private detectQueryIntent(query: string): {
    document_type?: string;
    metadata_filters?: Record<string, any>;
    query_type?: 'teaching_list' | 'teaching_check' | 'general';
  } {
    const q = this.normalizeForMatch(query);
    const filters: any = {};

    // Detect document type
    if (
      this.matchQueryPhrase(q, 'đề cương', 0.8) ||
      this.matchQueryPhrase(q, 'syllabus', 1) ||
      this.matchQueryPhrase(q, 'học phần', 0.8) ||
      this.matchQueryPhrase(q, 'môn học', 0.8)
    ) {
      filters.document_type = 'syllabus';
    } else if (
      this.matchQueryPhrase(q, 'chương trình đào tạo', 0.8) ||
      this.matchQueryPhrase(q, 'ctđt', 1) ||
      this.matchQueryPhrase(q, 'curriculum', 1)
    ) {
      filters.document_type = 'curriculum';
    } else if (
      this.matchQueryPhrase(q, 'quy định', 0.8) ||
      this.matchQueryPhrase(q, 'quy chế', 0.8) ||
      this.matchQueryPhrase(q, 'quyết định', 0.8)
    ) {
      filters.document_type = 'regulation';
    }

    // Teaching queries should lean to syllabus unless a type is already set
    const isTeachingQuery =
      this.matchQueryPhrase(q, 'giang vien', 0.8) ||
      this.matchQueryPhrase(q, 'giao vien', 0.8) ||
      this.matchQueryPhrase(q, 'thay', 1) ||
      this.hasToken(q, 'co') ||
      this.matchQueryPhrase(q, 'day', 1);

    if (!filters.document_type && isTeachingQuery) {
      filters.document_type = 'syllabus';
    }

    // 🆕 Detect teaching list vs teaching check queries
    if (isTeachingQuery) {
      const isListQuery = 
        this.matchQueryPhrase(q, 'nhung mon', 0.7) ||
        this.matchQueryPhrase(q, 'cac mon', 0.7) ||
        this.matchQueryPhrase(q, 'mon nao', 0.7) ||
        this.matchQueryPhrase(q, 'mon gi', 0.7) ||
        q.includes('day gi') ||
        q.includes('day nhung') ||
        q.includes('day cac') ||
        q.includes('phu trach mon') ||
        q.includes('giang day');

      const isCheckQuery =
        this.matchQueryPhrase(q, 'co day', 0.8) ||
        this.matchQueryPhrase(q, 'co phu trach', 0.8) ||
        q.includes('co day mon') ||
        q.includes('khong');

      if (isListQuery && !isCheckQuery) {
        filters.query_type = 'teaching_list';
        console.log('🎯 Detected: Teaching List Query');
      } else if (isCheckQuery) {
        filters.query_type = 'teaching_check';
        console.log('🎯 Detected: Teaching Check Query');
      } else {
        filters.query_type = 'general';
      }
    }

    // Detect major
    if (this.matchQueryPhrase(q, 'công nghệ thông tin', 0.8) || this.hasToken(q, 'cntt')) {
      filters.metadata_filters = {
        ...filters.metadata_filters,
        major: 'Công nghệ thông tin'
      };
    } else if (this.matchQueryPhrase(q, 'khoa học máy tính', 0.8) || this.hasToken(q, 'khmt')) {
      filters.metadata_filters = {
        ...filters.metadata_filters,
        major: 'Khoa học máy tính'
      };
    }

    // Detect subject code (e.g., CNTT1153)
    const codeMatch = q.match(/[a-z]{2,4}\s*\d{3,4}/i);
    if (codeMatch) {
      const code = codeMatch[0].replace(/\s+/g, '').toUpperCase();
      filters.metadata_filters = {
        ...filters.metadata_filters,
        subject_code: code
      };
    }

    return filters;
  }

  /* =====================================================
     RE-RANK WITH METADATA
  ====================================================== */
  private rerankWithMetadata(chunks: SearchResult[], query: string): SearchResult[] {
    const q = this.normalizeForMatch(query);
    const instructorName = this.extractInstructorName(query);
    const queryWantsCurriculum =
      this.matchQueryPhrase(q, 'chương trình đào tạo', 0.8) ||
      this.matchQueryPhrase(q, 'ctđt', 1) ||
      this.matchQueryPhrase(q, 'curriculum', 1);

    return chunks
      .map(c => {
        let score = c.similarity;
        const meta = c.metadata || ({} as any);
        const isCurriculum = c.document_type === 'curriculum';

        // Boost for document type match
        if (c.document_type === 'syllabus' && this.hasToken(q, 'de cuong')) {
          score += 0.15;
        }

        // Boost for source file mention
        if (this.queryMentionsSourceFile(q, meta.source_file)) {
          score += 0.3;
        }

        // 🆕 ENHANCED: Boost for instructor in teaching context
        if (instructorName) {
          const normalizedContent = this.normalizeForMatch(c.content);
          const normalizedInstructor = this.normalizeForMatch(instructorName);
          
          // Check if instructor mentioned in content
          const hasInstructor = normalizedContent.includes(normalizedInstructor);
          
          if (hasInstructor) {
            // Extra boost if in teaching section
            const isTeachingSection = 
              normalizedContent.includes('giang vien giang day') ||
              normalizedContent.includes('giang vien phu trach') ||
              normalizedContent.includes('nguoi giang day');
            
            if (isTeachingSection) {
              score += 0.35; // Strong boost for teaching section
              console.log(`🎓 Boosted chunk with instructor in teaching section`);
            } else {
              score += 0.15; // Moderate boost for other mentions
            }
          }
        }

        // Boost for subject match
        if (meta.subject_name && this.matchQueryPhrase(q, meta.subject_name, 0.7)) {
          score += 0.2;
        }
        if (meta.subject_code && this.hasToken(q, meta.subject_code)) {
          score += 0.25;
        }

        // Boost for major match
        if (meta.major && this.matchQueryPhrase(q, meta.major, 0.7)) {
          // Reduce boost for CTĐT (curriculum) chunks to prevent them from dominating rerank.
          score += isCurriculum ? 0.04 : 0.1;
        }

        // If the query is not about CTĐT, slightly downweight curriculum chunks.
        if (isCurriculum && !queryWantsCurriculum) {
          score -= 0.06;
        }

        return { ...c, similarity: Math.max(0, Math.min(score, 1.0)) };
      })
      .sort((a, b) => b.similarity - a.similarity);
  }

  /* =====================================================
     BUILD CONTEXT WITH METADATA
  ====================================================== */
  private buildContextWithMetadata(chunks: SearchResult[]): string {
    return chunks
      .map(c => {
        const meta = c.metadata || ({} as any);
        let header = `[${c.document_type.toUpperCase()}]`;

        if (c.document_type === 'syllabus') {
          if (meta.subject_name) header += `\nMôn: ${meta.subject_name}`;
          if (meta.subject_code) header += ` (${meta.subject_code})`;
          if (meta.credits) header += `\nTín chỉ: ${meta.credits}`;
          if (meta.major) header += `\nNgành: ${meta.major}`;
        } else if (c.document_type === 'regulation') {
          header += `\nLoại: Quy định`;
          if (meta.regulation_type) header += `\nPhân loại: ${meta.regulation_type}`;
          if (meta.decision_number) header += `\nSố QĐ: ${meta.decision_number}`;
        } else if (c.document_type === 'curriculum') {
          header += `\nLoại: Chương trình đào tạo`;
          if (meta.program_name) header += `\nChương trình: ${meta.program_name}`;
          if (meta.major_code) header += `\nMã ngành: ${meta.major_code}`;
          if (meta.total_credits) header += `\nTổng tín chỉ: ${meta.total_credits}`;
        }

        return `${header}\n\n${c.content}`;
      })
      .join('\n\n---\n\n');
  }

  /* =====================================================
     LLM GENERATION (Enhanced for teaching queries)
  ====================================================== */
  private async generateResponse(
    query: string,
    context: string,
    chunks: SearchResult[],
    queryType?: string
  ): Promise<string> {
    // Build source list
    const sources = chunks
      .map(c => {
        const meta = c.metadata || ({} as any);
        if (c.document_type === 'syllabus') {
          return `- Đề cương: ${meta.subject_name || 'N/A'} (${meta.subject_code || 'N/A'})`;
        } else if (c.document_type === 'regulation') {
          return `- Quy định: ${meta.source_file || 'N/A'}`;
        } else {
          return `- CTĐT: ${meta.major || meta.program_name || 'N/A'}`;
        }
      })
      .join('\n');

    // 🆕 Enhanced system prompt for teaching list queries
    let systemPrompt = `Bạn là trợ lý AI của Đại học Kinh tế Quốc dân.

NGUYÊN TẮC CHUNG:
- Ưu tiên thông tin trong TÀI LIỆU và suy luận hợp lý từ TÀI LIỆU khi cần.
- Trích dẫn rõ nguồn (tên môn, mã môn, số quyết định, v.v.).
- Nếu không đủ thông tin để trả lời, hãy nói: "Không tìm thấy thông tin."`;

    if (queryType === 'teaching_list') {
      systemPrompt += `

ĐẶC BIỆT CHO CÂU HỎI VỀ DANH SÁCH MÔN HỌC:
- CHỈ liệt kê các môn tìm thấy trong phần "Giảng viên giảng dạy học phần".
- KHÔNG tính các môn mà giảng viên chỉ ký duyệt hoặc biên soạn.
- Format: Số thứ tự + Tên môn + Mã môn (nếu có).
- Nếu chỉ tìm thấy ít môn, nói rõ: "Dựa trên các đề cương có sẵn, tìm thấy X môn..."
- KHÔNG từ chối trả lời nếu có ít nhất 1-2 môn học.
- Thêm disclaimer: "Thông tin từ phần Giảng viên giảng dạy học phần trong đề cương."`;
    }

    const userContent = `TÀI LIỆU THAM KHẢO:\n${context}\n\nCÂU HỎI:\n${query}\n\nHãy trả lời dựa trên tài liệu trên.`;

    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const answer = await this.openaiChat(messages, { 
      temperature: queryType === 'teaching_list' ? 0.1 : 0.2,
      top_p: 0.9 
    });

    // Keep behavior: answer only (sources available if you want to append later)
    void sources;
    return answer;
  }

  private async openaiChat(
    messages: OpenAIChatMessage[],
    options: { temperature?: number; top_p?: number } = {}
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.openaiTimeoutMs);

    try {
      const res = await fetch(`${this.openaiBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openaiApiKey}`
        },
        body: JSON.stringify({
          model: this.openaiChatModel,
          messages,
          temperature: options.temperature ?? 0.2,
          top_p: options.top_p ?? 0.9
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI error (${res.status}): ${text || res.statusText}`);
      }

      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('OpenAI returned empty response content');
      }

      return content.trim();
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeForMatch(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private hasExactPhrase(queryNormalized: string, phraseNormalized: string): boolean {
    if (!phraseNormalized) return false;
    const escaped = this.escapeRegExp(phraseNormalized);
    const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'i');
    return re.test(queryNormalized);
  }

  private tokenOverlapRatio(queryNormalized: string, phraseNormalized: string): number {
    if (!queryNormalized || !phraseNormalized) return 0;
    const qTokens = new Set(queryNormalized.split(' ').filter(Boolean));
    const pTokens = phraseNormalized.split(' ').filter(Boolean);
    if (pTokens.length === 0) return 0;
    let hit = 0;
    for (const t of pTokens) {
      if (qTokens.has(t)) hit += 1;
    }
    return hit / pTokens.length;
  }

  private matchQueryPhrase(queryNormalized: string, phrase: string, minTokenRatio = 0.6): boolean {
    const phraseNormalized = this.normalizeForMatch(phrase);
    if (!phraseNormalized) return false;
    if (this.hasExactPhrase(queryNormalized, phraseNormalized)) return true;

    const tokens = phraseNormalized.split(' ').filter(Boolean);
    if (tokens.length === 1) {
      const token = tokens[0];
      if (token.length < 3) {
        return false;
      }
    }

    return this.tokenOverlapRatio(queryNormalized, phraseNormalized) >= minTokenRatio;
  }

  private hasToken(queryNormalized: string, token: string): boolean {
    const tokenNormalized = this.normalizeForMatch(token);
    return this.hasExactPhrase(queryNormalized, tokenNormalized);
  }

  private extractInstructorName(query: string): string | null {
    const q = this.normalizeForMatch(query);
    const markers = ['thay', 'co', 'giang vien', 'giao vien'];
    for (const marker of markers) {
      const isMatch = marker.length < 3
        ? this.hasToken(q, marker)
        : this.matchQueryPhrase(q, marker, 1);
      if (isMatch) {
        const after = q.split(marker).slice(1).join(' ').trim();
        if (!after) continue;
        const cutoff = after.split(' ').slice(0, 4).join(' ').trim();
        return cutoff || null;
      }
    }

    if (this.matchQueryPhrase(q, 'day', 1)) {
      const parts = q.split('day').slice(1).join(' ').trim();
      const tokens = parts.split(' ').filter(Boolean);
      if (tokens.length >= 2) {
        return tokens.slice(0, 4).join(' ');
      }
    }

    return null;
  }

  private queryMentionsSourceFile(queryNormalized: string, sourceFile?: string): boolean {
    if (!sourceFile) return false;
    const full = this.normalizeForMatch(sourceFile);
    const noExt = this.normalizeForMatch(sourceFile.replace(/\.[^/.]+$/, ''));
    return this.hasExactPhrase(queryNormalized, full) || this.hasExactPhrase(queryNormalized, noExt);
  }

  private getNameMatchBonus(queryNormalized: string, name?: string): number {
    if (!name) return 0;
    const nameNormalized = this.normalizeForMatch(name);
    if (!nameNormalized) return 0;

    // Full name match gets a higher boost.
    if (queryNormalized.includes(nameNormalized)) {
      return 0.25;
    }

    const tokens = nameNormalized.split(' ').filter(Boolean);
    const meaningful = tokens.filter(t => t.length >= 3);
    const candidates = meaningful.length > 0 ? meaningful : tokens;
    const hasPartial = candidates.some(t => queryNormalized.includes(t));

    return hasPartial ? 0.1 : 0;
  }

  private detectMentionedSourceFile(query: string, chunks: SearchResult[]): string | null {
    const q = this.normalizeForMatch(query);
    const matches = chunks
      .map(c => c.metadata?.source_file)
      .filter((f): f is string => !!f)
      .filter(f => this.queryMentionsSourceFile(q, f));

    if (matches.length === 0) return null;
    return matches[0];
  }

  private queryMentionsSubject(query: string, meta: Record<string, any>): boolean {
    const q = this.normalizeForMatch(query);
    const subjectName = meta?.subject_name ? this.normalizeForMatch(meta.subject_name) : '';
    const subjectCode = meta?.subject_code ? this.normalizeForMatch(meta.subject_code) : '';

    if (subjectCode && this.hasToken(q, subjectCode)) return true;
    if (subjectName && this.matchQueryPhrase(q, subjectName, 0.8)) return true;
    return false;
  }

  private noContext(): string {
    return 'Không tìm thấy thông tin phù hợp trong tài liệu. Vui lòng liên hệ phòng Đào tạo để được hỗ trợ.';
  }
}
