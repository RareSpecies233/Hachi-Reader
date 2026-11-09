package wkk

import "strings"

// Book 书籍元信息
type Book struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Subtitle    string   `json:"subtitle"`
	Author      string   `json:"author"`
	Publisher   string   `json:"publisher"`
	Cover       string   `json:"cover"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
	WordCount   int      `json:"wordCount"`
	UpdatedAt   string   `json:"updatedAt"`
	IsComplete  bool     `json:"isComplete"`
	IsAnime     bool     `json:"isAnime"`

	VolumeCount  int `json:"volumeCount"`
	ChapterCount int `json:"chapterCount"`
}

// Chapter 章节
type Chapter struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Index int    `json:"index"`
}

// Volume 卷
type Volume struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Chapters []Chapter `json:"chapters"`
}

// Block 正文块：文本或插图
type Block struct {
	Type string `json:"type"` // text | image
	Text string `json:"text,omitempty"`
	Src  string `json:"src,omitempty"`
}

// ChapterContent 章节正文
type ChapterContent struct {
	ID     string  `json:"id"`
	Title  string  `json:"title"`
	Index  int     `json:"index"`
	Total  int     `json:"total"`
	Blocks []Block `json:"blocks"`
	Prev   string  `json:"prev"`
	Next   string  `json:"next"`
}

// ListPage 列表页结果
type ListPage struct {
	Items   []Book `json:"items"`
	Page    int    `json:"page"`
	HasMore bool   `json:"hasMore"`
}

// Tags 内置标签，与站点分类一致。
var Tags = []string{
	"校园", "青春", "恋爱", "治愈", "群像",
	"竞技", "音乐", "美食", "旅行", "欢乐向",
	"经营", "职场", "斗智", "脑洞", "宅文化",
	"穿越", "奇幻", "魔法", "异能", "战斗",
	"科幻", "机战", "战争", "冒险", "龙傲天",
	"悬疑", "犯罪", "复仇", "黑暗", "猎奇",
	"惊悚", "间谍", "末日", "游戏", "大逃杀",
	"青梅竹马", "妹妹", "女儿", "JK", "JC",
	"大小姐", "性转", "伪娘", "人外",
	"后宫", "百合", "耽美", "NTR", "女性视角",
}

// clean 去掉不可见字符与多余空白
func clean(s string) string {
	s = strings.ReplaceAll(s, "\u00a0", " ")
	s = strings.ReplaceAll(s, "\u3000", " ")
	s = strings.ReplaceAll(s, "\r", "")
	return strings.TrimSpace(s)
}

// afterColon 取 "小说作者：野村美月" 冒号后的部分
func afterColon(s string) string {
	for _, sep := range []string{"：", ":"} {
		if i := strings.Index(s, sep); i >= 0 {
			return clean(s[i+len(sep):])
		}
	}
	return clean(s)
}
