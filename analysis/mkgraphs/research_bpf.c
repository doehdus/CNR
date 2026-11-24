/* Research-stage linear-PSD evidence and exact single-pass Butterworth scan.
 * Reuse the verified prewarped bandpass power response; no audio generation.
 */
#define main legacy_bpf_main
#include "compare_bpf.c"
#undef main

typedef struct { char id[100]; int kind, noise; double *p[3], total[3]; } Evidence;
static const double edges[] = {0,50,80,100,150,200,300,500,1000,2000,4000,6000,8001};
static double gain(double f, double fs, Candidate c, int type) {
    double x, q;
    if (!type) return 1;
    if (type == 3) return power_gain(f,fs,c);
    if (f == 0) return type == 1 ? 0 : 1;
    if (f == fs/2) return type == 1 ? 1 : 0;
    x=tan(PI*f/fs); q=tan(PI*(type==1?c.low:c.high)/fs);
    return 1/(1+pow(type==1?q/x:x/q,2*c.order));
}
static void number(FILE *f,double x) { if(isfinite(x)) fprintf(f,"%.17g",x); }
int main(int argc,char **argv) {
    FILE *in,*desc,*metrics,*details,*responses=NULL; char magic[40],extra[2];
    double fs,*freq,*weights; int bins,nc,ns,i,j,k,t,types[32768];
    Candidate *cs; Evidence *es;
    if(argc!=5&&argc!=6) fail("expected input descriptors.csv metrics.csv details.csv [responses.csv]");
    for(i=1;i<argc;i++)for(j=i+1;j<argc;j++)if(!strcmp(argv[i],argv[j]))fail("paths must differ");
    for(i=2;i<argc;i++){FILE *p=fopen(argv[i],"rb");if(p){fclose(p);fail("output exists");}}
    in=fopen(argv[1],"rb");if(!in)fail("cannot read evidence");
    if(fscanf(in,"%39s%lf%d%d%d",magic,&fs,&bins,&nc,&ns)!=5||strcmp(magic,"CNR_BPF_RESEARCH_1")||fs!=16000||bins<3||bins>MAX_BINS||nc<0||nc>32768||ns<1||ns>MAX_CASES)fail("bad evidence header");
    freq=allocate(bins,sizeof(double));weights=allocate(bins,sizeof(double));
    cs=allocate(nc+1,sizeof(Candidate));es=allocate(ns,sizeof(Evidence));
    for(k=0;k<bins;k++)if(fscanf(in,"%lf",freq+k)!=1||!isfinite(freq[k])||freq[k]<0||freq[k]>fs/2||(k&&freq[k]<=freq[k-1]))fail("bad frequency grid");
    for(i=0;i<nc;i++){
        Candidate *c=cs+i;
        if(fscanf(in,"%79s%d%lf%lf%d",c->id,types+i,&c->low,&c->high,&c->order)!=5||types[i]<0||types[i]>3||!isfinite(c->low)||!isfinite(c->high)||c->order<1||c->order>16)fail("bad candidate");
        if((types[i]==1&&!(c->low>0&&c->low<8000))||(types[i]==2&&!(c->high>0&&c->high<8000))||(types[i]==3&&!(c->low>0&&c->low<c->high&&c->high<8000)))fail("invalid cutoffs");
        if(strspn(c->id,"abcdefghijklmnopqrstuvwxyz0123456789_")!=strlen(c->id))fail("bad candidate ID");
        for(j=0;j<i;j++)if(!strcmp(c->id,cs[j].id))fail("duplicate candidate");
    }
    for(j=0;j<ns;j++){
        Evidence *e=es+j;
        if(fscanf(in,"%99s%d%d",e->id,&e->kind,&e->noise)!=3||e->kind<0||e->kind>4||e->noise<0||e->noise>3||strspn(e->id,"abcdefghijklmnopqrstuvwxyz0123456789_")!=strlen(e->id))fail("bad case");
        for(t=0;t<3;t++){
            e->p[t]=allocate(bins,sizeof(double));
            for(k=0;k<bins;k++){double p;if(fscanf(in,"%lf",&p)!=1||!isfinite(p)||p<0)fail("invalid linear PSD");e->p[t][k]=p;e->total[t]+=p;}
        }
        if((e->kind==0&&e->total[1]<=0)||(e->kind==1&&e->total[2]<=0)||(e->kind>=2&&(e->total[1]<=0||e->total[2]<=0)))fail("empty required spectrum");
    }
    if(fscanf(in,"%1s",extra)==1)fail("unexpected trailing data");fclose(in);
    desc=fopen(argv[2],"wb");metrics=fopen(argv[3],"wb");details=fopen(argv[4],"wb");
    if(!desc||!metrics||!details)fail("cannot create outputs");
    if(argc==6){responses=fopen(argv[5],"wb");if(!responses)fail("cannot create responses");fprintf(responses,"candidate_id,frequency_hz,power_gain,gain_db\n");}
    fprintf(desc,"case_id,signal,total_psd_sum,peak_hz,q005_hz,q01_hz,q02_hz,q05_hz,q50_hz,q95_hz,q98_hz,q99_hz,q995_hz");
    for(t=0;t<12;t++)fprintf(desc,",band_%g_%g_percent",edges[t],edges[t+1]);fputc('\n',desc);
    for(j=0;j<ns;j++)for(t=0;t<3;t++)if(es[j].total[t]>0){
        Evidence e=es[j];double acc=0,bands[12]={0},quantiles[9]={0},qs[]={.005,.01,.02,.05,.5,.95,.98,.99,.995};int peak=0,q=0,b;
        for(k=0;k<bins;k++){
            if(e.p[t][k]>e.p[t][peak])peak=k;acc+=e.p[t][k];
            while(q<9&&acc>=qs[q]*e.total[t])quantiles[q++]=freq[k];
            for(b=0;b<12;b++)if(freq[k]>=edges[b]&&freq[k]<edges[b+1])bands[b]+=e.p[t][k];
        }
        fprintf(desc,"%s,%s,%.17g,%.17g",e.id,t==0?"mixture":t==1?"speech":"noise",e.total[t],freq[peak]);
        for(q=0;q<9;q++)fprintf(desc,",%.17g",quantiles[q]);
        for(b=0;b<12;b++)fprintf(desc,",%.17g",100*bands[b]/e.total[t]);fputc('\n',desc);
    }
    fprintf(metrics,"candidate_id,type,lower_hz,upper_hz,prototype_order,digital_order,clean_mean_percent,clean_min_percent,clean_max_percent,clean_2_4k_min_percent,clean_4_8k_min_percent,noise_mean_db,snr_mean_db,snr_min_db,snr_max_db,single_snr_db,complex_snr_db,changing_snr_db,whole_snr_mean_db\n");
    fprintf(details,"candidate_id,case_id,clean_retained_percent,noise_reduction_db,snr_change_db,clean_2_4k_retained_percent,clean_4_8k_retained_percent\n");
    for(i=0;i<nc;i++){
        Candidate c=cs[i];Stats clean={0},band24={0},band48={0},noise={0},snr={0},whole={0},by_noise[3]={{0}};
        for(k=0;k<bins;k++){
            weights[k]=gain(freq[k],fs,c,types[i]);
            if(responses){fprintf(responses,"%s,%.17g,%.17g,",c.id,freq[k],weights[k]);if(weights[k]>0)fprintf(responses,"%.17g",10*log10(weights[k]));fputc('\n',responses);}
        }
        for(j=0;j<ns;j++){
            Evidence e=es[j];double out[3]={0},bp[2]={0},bo[2]={0},keep=NAN,drop=NAN,delta=NAN,bkeep[2]={NAN,NAN};
            for(k=0;k<bins;k++){
                for(t=0;t<3;t++)out[t]+=e.p[t][k]*weights[k];
                if(freq[k]>=2000){int b=freq[k]<4000?0:1;bp[b]+=e.p[1][k];bo[b]+=e.p[1][k]*weights[k];}
            }
            if(e.total[1]>0){keep=100*out[1]/e.total[1];for(t=0;t<2;t++)if(bp[t]>0)bkeep[t]=100*bo[t]/bp[t];}
            if(e.total[2]>0&&out[2]>0)drop=-10*log10(out[2]/e.total[2]);
            if(isfinite(keep)&&keep>0&&isfinite(drop))delta=drop+10*log10(keep/100);
            if(e.kind==0){add(&clean,keep);if(isfinite(bkeep[0]))add(&band24,bkeep[0]);if(isfinite(bkeep[1]))add(&band48,bkeep[1]);}
            if(e.kind==2){add(&noise,drop);add(&snr,delta);if(e.noise<1)fail("mixture noise missing");add(by_noise+e.noise-1,delta);}
            if(e.kind==3)add(&whole,delta);
            /* Large scans keep aggregate statistics; selected candidates retain all paired cases. */
            if(nc<=16){fprintf(details,"%s,%s,",c.id,e.id);number(details,keep);fputc(',',details);number(details,drop);fputc(',',details);number(details,delta);for(t=0;t<2;t++){fputc(',',details);number(details,bkeep[t]);}fputc('\n',details);}
        }
        if(!clean.count||!snr.count||!whole.count)fail("clean, primary and whole evidence required");
        fprintf(metrics,"%s,%d,%.17g,%.17g,%d,%d,%.17g,%.17g,%.17g,%.17g,%.17g,%.17g,%.17g,%.17g,%.17g",c.id,types[i],c.low,c.high,c.order,types[i]==0?0:(types[i]==3?2*c.order:c.order),clean.sum/clean.count,clean.min,clean.max,band24.min,band48.min,noise.sum/noise.count,snr.sum/snr.count,snr.min,snr.max);
        for(t=0;t<3;t++){if(!by_noise[t].count)fail("all three noises required");fprintf(metrics,",%.17g",by_noise[t].sum/by_noise[t].count);}
        fprintf(metrics,",%.17g\n",whole.sum/whole.count);
    }
    if(ferror(desc)||ferror(metrics)||ferror(details))fail("write failed");
    if(fclose(desc)||fclose(metrics)||fclose(details))fail("close failed");
    if(responses&&(ferror(responses)||fclose(responses)))fail("response write failed");
    for(j=0;j<ns;j++)for(t=0;t<3;t++)free(es[j].p[t]);free(es);free(cs);free(freq);free(weights);return 0;
}
