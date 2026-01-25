// services/queryExpansion.service.ts
// phai lap ra 1 list query synonyms
//co the them sau này: queryExpansion.llm.ts

// services/queryExpansion.service.ts
// Mở rộng danh sách query synonyms để tìm kiếm chính xác hơn

const QUERY_SYNONYMS: Record<string, string[]> = {
    // Khóa luận & Đồ án
    "khóa luận": [
        "khóa luận tốt nghiệp",
        "quy trình thực hiện khóa luận",
        "hướng dẫn làm khóa luận",
        "đề cương khóa luận",
        "KLTN",
        "luận văn",
        "thesis"
    ],
    "đồ án": [
        "đồ án môn học",
        "đồ án tốt nghiệp",
        "ĐAMH",
        "ĐATN",
        "project"
    ],
    
    // Giảng viên
    "ai là người dạy": [
        "giảng viên",
        "thầy",
        "cô",
        "thầy cô",
        "giáo viên",
        "lecturer",
        "instructor",
        "ai dạy",
        "ai phụ trách",
        "người hướng dẫn",
        "có dạy"
    ],
    "giảng viên": [
        "thầy",
        "cô",
        "thầy cô",
        "giáo viên",
        "lecturer",
        "ai dạy"
    ],
    "thầy": [
        "giảng viên",
        "giáo viên",
        "thầy cô",
        "lecturer",
        "instructor",
        "người dạy"
    ],
    "cô": [
        "giảng viên",
        "giáo viên",
        "thầy cô",
        "lecturer",
        "instructor",
        "người dạy"
    ],
    "giáo viên": [
        "giảng viên",
        "thầy",
        "cô",
        "thầy cô",
        "lecturer",
        "instructor"
    ],
    "thạc sĩ": [
        "ths",
        "th.s",
        "th.s.",
        "thạc sỹ",
        "giảng viên"
    ],
    "ths": [
        "thạc sĩ",
        "thạc sỹ",
        "th.s",
        "th.s.",
        "giảng viên"
    ],
    "th.s": [
        "thạc sĩ",
        "thạc sỹ",
        "ths",
        "giảng viên"
    ],
    
    // Tín chỉ
    "tín chỉ": [
        "credits",
        "credit",
        "số credits",
        "số tín chỉ",
        "TC",
        "điểm tín chỉ"
    ],
    
    // Điểm số & Đánh giá
    "điểm": [
        "điểm số",
        "điểm thi",
        "điểm danh",
        "grade",
        "score",
        "point",
        "kết quả học tập",
        "thành tích"
    ],
    "gpa": [
        "điểm trung bình",
        "GPA",
        "điểm trung bình tích lũy",
        "grade point average",
        "CPA"
    ],
    
    // Học phần & Môn học
    "môn học": [
        "học phần",
        "course",
        "subject",
        "lớp học",
        "khóa học",
        "module"
    ],
    "môn": [
        "môn học",
        "học phần",
        "course",
        "subject"
    ],
    "học kỳ": [
        "kỳ học",
        "semester",
        "term",
        "HK1",
        "HK2",
        "học kì"
    ],
    
    // Lịch học & Thời khóa biểu
    "lịch học": [
        "thời khóa biểu",
        "TKB",
        "schedule",
        "timetable",
        "lịch trình học",
        "giờ học"
    ],
    "phòng học": [
        "classroom",
        "room",
        "lớp học",
        "phòng",
        "địa điểm học"
    ],
    
    // Đăng ký & Rút môn
    "đăng ký": [
        "đăng ký học phần",
        "registration",
        "enroll",
        "enrollment",
        "ĐKHP",
        "đky học"
    ],
    "hủy môn": [
        "hủy môn",
        "drop",
        "withdraw",
        "ngưng học"
    ],
    
    // Thi & Kiểm tra
    "thi": [
        "kiểm tra",
        "exam",
        "test",
        "bài thi",
        "kỳ thi",
        "thi cuối kỳ",
        "thi giữa kỳ"
    ],
    "lịch thi": [
        "exam schedule",
        "test schedule",
        "thời gian thi",
        "ngày thi"
    ],
    
    // Học phí & Tài chính
    "học phí": [
        "tuition",
        "tuition fee",
        "tiền học",
        "phí học",
        "chi phí học tập"
    ],
    "học bổng": [
        "scholarship",
        "grant",
        "bursary",
        "miễn giảm học phí"
    ],
    
    // Quy định & Thủ tục
    "quy định": [
        "quy chế",
        "regulation",
        "rule",
        "chính sách",
        "nội quy"
    ],
    "thủ tục": [
        "procedure",
        "process",
        "quy trình",
        "hướng dẫn",
        "cách thức"
    ],
    
    // Chuyên ngành
    "chuyên ngành": [
        "major",
        "specialization",
        "ngành học",
        "chuyên môn",
        "chuyên sâu"
    ],
    
    // Thực tập
    "thực tập": [
        "internship",
        "thực tập doanh nghiệp",
        "thực tập tốt nghiệp",
        "practice"
    ],
    
    // Công nợ & Thanh toán
    "công nợ": [
        "debt",
        "nợ học phí",
        "tiền nợ",
        "chưa thanh toán"
    ],
    
    // Chứng chỉ & Văn bằng
    "bằng cấp": [
        "degree",
        "diploma",
        "văn bằng",
        "chứng chỉ tốt nghiệp",
        "certificate"
    ],
    
    // Hoạt động ngoại khóa
    "hoạt động ngoại khóa": [
        "extracurricular",
        "CLB",
        "club",
        "câu lạc bộ",
        "sinh hoạt"
    ],
    
    // Tốt nghiệp
    "tốt nghiệp": [
        "graduation",
        "graduate",
        "ra trường",
        "hoàn thành chương trình"
    ],
    
    // Điều kiện & Yêu cầu
    "điều kiện": [
        "requirement",
        "prerequisite",
        "yêu cầu",
        "tiên quyết",
        "cần có"
    ],
    
    // Thời hạn
    "deadline": [
        "hạn chót",
        "thời hạn",
        "hết hạn",
        "due date",
        "ngày cuối"
    ],

    // Cố vấn học tập
    "cố vấn": [
        "cố vấn học tập",
        "advisor",
        "CVHT",
        "người tư vấn"
    ],

    // Phòng ban
    "phòng đào tạo": [
        "phòng QLĐT",
        "đào tạo",
        "academic affairs",
        "training department"
    ],
    "phòng công tác sinh viên": [
        "CTSV",
        "student affairs",
        "phòng sinh viên"
    ]
};

const ALL_SYNONYMS: Record<string, string[]> = {
    ...QUERY_SYNONYMS
};

/**
 * Mở rộng query với các từ đồng nghĩa
 * @param query - Câu truy vấn gốc
 * @returns Mảng các query đã được mở rộng
 */
export function expandQuery(query: string): string[] {
    const expanded = new Set<string>();
    expanded.add(query);
    
    const lowerQuery = query.toLowerCase();
    
    // Tìm kiếm partial match
    for (const key in ALL_SYNONYMS) {
        if (lowerQuery.includes(key)) {
            const pattern = new RegExp(escapeRegExp(key), 'gi');
            ALL_SYNONYMS[key].forEach(synonym => {
                expanded.add(synonym);
                expanded.add(query.replace(pattern, synonym));
            });
        }
    }

    const strippedMon = query
        .replace(/\bmôn\s+(?!học\b)/gi, '')
        .replace(/\bmon\s+(?!hoc\b)/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (strippedMon && strippedMon !== query) {
        expanded.add(strippedMon);
    }
    
    return Array.from(expanded);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lấy tất cả từ đồng nghĩa của một từ khóa
 * @param keyword - Từ khóa cần tìm
 * @returns Mảng các từ đồng nghĩa
 */
export function getSynonyms(keyword: string): string[] {
    const lowerKeyword = keyword.toLowerCase();
    return ALL_SYNONYMS[lowerKeyword] || [];
}

/**
 * Kiểm tra xem query có chứa từ khóa nào không
 * @param query - Câu truy vấn
 * @param keywords - Danh sách từ khóa cần kiểm tra
 * @returns true nếu query chứa ít nhất một từ khóa
 */
export function containsKeywords(query: string, keywords: string[]): boolean {
    const lowerQuery = query.toLowerCase();
    return keywords.some(keyword => lowerQuery.includes(keyword.toLowerCase()));
}
