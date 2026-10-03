import {validateCandidate,type EvidenceSource,type EvaluatedCandidate} from './candidates.js'
/** Synthetic fixture only; never seed this into a user's actual data. */
export function understandingFixture():EvaluatedCandidate[]{
 const source:EvidenceSource={id:'synthetic-language-1',version:1,origin:'user',text:'我想学日语。请记下明天比较三门日语课。我喜欢用听力材料学习。'}
 return ([['goal','我想学日语。','aspiration'],['todo','请记下明天比较三门日语课。','request'],['profile','我喜欢用听力材料学习。','preference']] as const).map(([kind,quote,modality])=>({source:{...source},candidate:validateCandidate(source,{source_id:source.id,source_version:source.version,span:{start:source.text.indexOf(quote),end:source.text.indexOf(quote)+quote.length,quote},kind,text:quote}),decision:{attribution:'user',modality,support:'supported',importance:'useful'},status:'proposed',reasons:[]}))
}
