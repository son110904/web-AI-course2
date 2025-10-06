export function Footer() {
  return (
    <footer className="bg-[#0066B3] text-white py-6 px-6 relative">
      <div className="container mx-auto max-w-screen-xl">
        <div className="flex items-center gap-4 ml-2.5">
          {/* Left content - logo and info */}
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <img src="/neu_panda-modified.png" alt="Logo" className="w-16 h-16 object-contain flex-shrink-0" />
            <div className="text-sm">
              <p className="font-semibold mb-2">Đại học Kinh tế quốc dân</p>
              <p className="text-white/90 flex items-center gap-2 mb-1">
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                <span>207 Giải Phóng, Đồng Tâm, Hai Bà Trưng, Hà Nội, Việt Nam</span>
              </p>
              <p className="text-white/90 flex items-center gap-2 mb-1">
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                  />
                </svg>
                <span>(84)24.36.280.280</span>
              </p>
              <p className="text-white/90 flex items-center gap-2">
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                </svg>
                <span>facebook.com/ktqqNEU</span>
              </p>
            </div>
          </div>
        </div>
      </div>
      {/* Gray box */}
      <div className="absolute top-1/2 -translate-y-1/2 right-[85px] w-[100px] h-[100px] bg-gray-300 hidden md:block"></div>
    </footer>
  )
}
